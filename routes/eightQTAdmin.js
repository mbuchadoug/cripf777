// routes/eightQTAdmin.js
// Admin panel for the 8 Quotients Test:
//   - Quotient config (active, question count, descriptions)
//   - Question bank (CSV upload + inline edit)
//   - Archetype management
//   - Certificate template config
//   - Analytics dashboard
//   - Attempt explorer: full quiz review, right/wrong per answer
//   - Certificate preview (no payment required)
//   - Manual certificate issuance
//   - Cert pipeline (high-scorers without certs)
//   - Search + CSV export

import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse";
import fs from "fs";
import crypto from "crypto";
import { ensureAuth } from "../middleware/authGuard.js";
import EightQTConfig from "../models/eightQTConfig.js";
import EightQTQuiz from "../models/eightQTQuiz.js";
import EightQTQuestion from "../models/eightQTQuestion.js";
import mongoose from "mongoose";
import EightQTArchetype from "../models/eightQTArchetype.js";
import EightQTCertTemplate from "../models/eightQTCertTemplate.js";
import EightQTAttempt from "../models/eightQTAttempt.js";
import EightQTCertPurchase from "../models/eightQTCertPurchase.js";
import { generateEightQTCertPdf } from "../services/eightQTCertPdf.js";

const router = Router();
const upload = multer({ dest: "uploads/", limits: { fileSize: 5 * 1024 * 1024 } });

// ── Guard: super_admin OR readonly_admin ────────────────────────────
function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorised" });
  const allowed = ["super_admin", "readonly_admin", "org_admin"];
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const isAdminEmail = adminEmails.includes((req.user.email || "").toLowerCase());
  if (isAdminEmail || allowed.includes(req.user.role)) return next();
  return res.status(403).json({ error: "Forbidden" });
}

function writeOnly(req, res, next) {
  if (req.user?.role === "readonly_admin") {
    return res.status(403).json({ error: "Read-only access - cannot modify" });
  }
  next();
}

router.use(ensureAuth, adminOnly);

// ══════════════════════════════════════════════════════════════
// RENDER: Admin Panel
// GET /admin/8qt
// ══════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const configs = await EightQTConfig.find().sort({ displayOrder: 1 }).lean();
    const template = await EightQTCertTemplate.findOne({ active: true }).lean();
    const totalAttempts = await EightQTAttempt.countDocuments();
    const finished = await EightQTAttempt.countDocuments({ status: "finished" });
    const certIssued = await EightQTAttempt.countDocuments({ certificateStatus: "issued" });
    const certPaid = await EightQTAttempt.countDocuments({ certificateStatus: "paid" });
    const anonymous = await EightQTAttempt.countDocuments({ userId: null });

    const avgPipeline = [
      { $match: { status: "finished" } },
      { $unwind: "$quotientScores" },
      { $group: {
          _id: "$quotientScores.code",
          avgScore: { $avg: "$quotientScores.score" },
          name: { $first: "$quotientScores.name" }
        }
      },
      { $sort: { avgScore: 1 } }
    ];
    const quotientAverages = await EightQTAttempt.aggregate(avgPipeline);

    const archetypeAgg = await EightQTAttempt.aggregate([
      { $match: { status: "finished", archetypeName: { $ne: null } } },
      { $group: { _id: "$archetypeName", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    const certRequested = await EightQTAttempt.countDocuments({ certificateStatus: { $ne: "none" } });

    const quizzes = await EightQTQuiz.find().sort({ isDefault: -1, updatedAt: -1 }).lean();

    res.render("8qt/admin/panel", {
      configs,
      template,
      quizzes,
      stats: {
        totalAttempts,
        finished,
        certIssued,
        certPaid,
        certRequested,
        anonymous,
        conversionRate: finished > 0
          ? Math.round((certRequested / finished) * 100) : 0
      },
      quotientAverages,
      archetypeAgg
    });
  } catch (err) {
    console.error("[8qt admin]", err);
    res.status(500).send("Error loading admin panel");
  }
});

// ══════════════════════════════════════════════════════════════
// QUOTIENT CONFIG
// ══════════════════════════════════════════════════════════════

router.get("/config", async (req, res) => {
  const configs = await EightQTConfig.find().sort({ displayOrder: 1 }).lean();
  res.json({ configs });
});

router.post("/config/seed", writeOnly, async (req, res) => {
  const count = await EightQTConfig.countDocuments();
  if (count > 0) return res.json({ message: "Already seeded", count });

  const defaults = [
    { code: "CsQ", name: "Consciousness",  questionCount: 8, displayOrder: 1, color: "#2f6ef7" },
    { code: "RQ",  name: "Responsibility", questionCount: 8, displayOrder: 2, color: "#7c3aed" },
    { code: "IQ",  name: "Interpretation", questionCount: 8, displayOrder: 3, color: "#0d9488" },
    { code: "PQ",  name: "Purpose",        questionCount: 8, displayOrder: 4, color: "#d97706" },
    { code: "FQ",  name: "Frequencies",    questionCount: 8, displayOrder: 5, color: "#e11d48" },
    { code: "CvQ", name: "Civilization",   questionCount: 8, displayOrder: 6, color: "#059669" },
    { code: "NQ",  name: "Negotiation",    questionCount: 8, displayOrder: 7, color: "#4f46e5" },
    { code: "TQ",  name: "Technology",     questionCount: 8, displayOrder: 8, color: "#ea580c" }
  ];

  await EightQTConfig.insertMany(defaults);
  res.json({ ok: true, message: "Seeded 8 quotients", count: 8 });
});

router.patch("/config/:code", writeOnly, async (req, res) => {
  try {
    const allowed = [
      "name", "description", "dominantInterpretation", "developmentEdge",
      "questionCount", "weight", "active", "displayOrder", "color"
    ];
    const update = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    const doc = await EightQTConfig.findOneAndUpdate(
      { code: req.params.code },
      { $set: update },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, config: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// QUESTION BANK
// ══════════════════════════════════════════════════════════════

router.get("/questions", async (req, res) => {
  try {
    const filter = {};
    if (req.query.quotient) filter.quotient = req.query.quotient;
    if (req.query.active !== undefined) filter.active = req.query.active === "true";
    if (req.query.batch) filter.importBatch = req.query.batch;

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 20;
    const total = await EightQTQuestion.countDocuments(filter);
    const questions = await EightQTQuestion.find(filter)
      .sort({ quotient: 1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({ questions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/8qt/questions/import - CSV upload
// CSV columns: quotient, text, opt_a_text, opt_a_scores (JSON),
//              opt_b_text, opt_b_scores, opt_c_text, opt_c_scores,
//              opt_d_text, opt_d_scores, is_blended
// POST /admin/8qt/questions/import - CSV upload
// CSV columns: quotient, text, opt_a_text, opt_a_scores (JSON),
//              opt_b_text, opt_b_scores, opt_c_text, opt_c_scores,
//              opt_d_text, opt_d_scores, is_blended
// Optional form fields (multipart text alongside the file):
//   quizTitle   - if present, a FIXED quiz is created from this upload's
//                 questions, titled by admin, attemptable at /8qt/q/:slug
//   quizDefault - "true" to make that quiz the default served at /8qt
router.post("/questions/import", writeOnly, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const batch = crypto.randomUUID();
  const results = [];
  const errors = [];
  let rowNum = 0;

  try {
    await new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path)
        .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
        .on("data", row => {
          rowNum++;
          try {
            if (!row.quotient || !row.text) {
              errors.push({ row: rowNum, error: "Missing quotient or text" });
              return;
            }

            const options = [];
            for (const letter of ["a", "b", "c", "d"]) {
              const text = row[`opt_${letter}_text`];
              if (!text) continue;
              let scores = {};
              try { scores = JSON.parse(row[`opt_${letter}_scores`] || "{}"); }
              catch { scores = {}; }
              options.push({ text, scores });
            }

            if (options.length < 2) {
              errors.push({ row: rowNum, error: "Need at least 2 options" });
              return;
            }

            results.push({
              quotient: row.quotient.trim(),
              text: row.text.trim(),
              options,
              isBlended: row.is_blended === "true" || row.is_blended === "1",
              active: true,
              createdBy: req.user._id,
              importBatch: batch
            });
          } catch (e) {
            errors.push({ row: rowNum, error: e.message });
          }
        })
        .on("end", resolve)
        .on("error", reject);
    });

    let inserted = 0;
    let insertedDocs = [];
    if (results.length > 0) {
      insertedDocs = await EightQTQuestion.insertMany(results, { ordered: false });
      inserted = insertedDocs.length;
    }

    fs.unlink(req.file.path, () => {});

    // ── Optionally wrap this upload as a titled, attemptable quiz ──
    // Three admin modes (mutually exclusive, all batched under `batch`):
    //   1. Bank only        - no quizTitle, no appendQuizId
    //   2. Create new quiz  - quizTitle set: fixed quiz from THIS upload's
    //                         questions, shareable at /8qt/q/:slug,
    //                         optionally made default
    //   3. Append to quiz   - appendQuizId set: pushes this upload's
    //                         questions onto an existing FIXED quiz
    let quiz = null;
    const quizTitle    = (req.body.quizTitle || "").trim();
    const appendQuizId = (req.body.appendQuizId || "").trim();

    if (appendQuizId && inserted > 0) {
      try {
        if (!mongoose.isValidObjectId(appendQuizId)) throw new Error("Invalid quiz id");
        const target = await EightQTQuiz.findById(appendQuizId);
        if (!target) throw new Error("Quiz to append to was not found");
        if (target.mode !== "fixed") throw new Error("Can only append questions to a FIXED quiz");
        target.questionIds.push(...insertedDocs.map(d => d._id));
        await target.save();
        quiz = target;
      } catch (e) {
        errors.push({ row: 0, error: `Append to quiz failed: ${e.message}` });
      }
    } else if (quizTitle && inserted > 0) {
      try {
        quiz = await EightQTQuiz.create({
          title: quizTitle,
          description: `Imported from CSV on ${new Date().toISOString().slice(0, 10)} (${inserted} questions)`,
          mode: "fixed",
          questionIds: insertedDocs.map(d => d._id),
          shuffleQuestions: true,
          shuffleOptions: true,
          active: true,
          isDefault: req.body.quizDefault === "true",
          // Per-quiz retake policy straight from the upload form
          retakeDays:           Math.max(0, Number(req.body.retakeDays) || 0),
          maxAttemptsPerPerson: Math.max(0, Number(req.body.maxAttempts) || 0),
          importBatch: batch,
          createdBy: req.user._id
        });
        if (quiz.isDefault) {
          await EightQTQuiz.updateMany({ _id: { $ne: quiz._id } }, { $set: { isDefault: false } });
        }
      } catch (e) {
        // Duplicate slug etc. - questions are already imported; report but don't fail
        errors.push({ row: 0, error: `Quiz creation failed: ${e.message}` });
      }
    }

    res.json({
      ok: true,
      inserted,
      errors,
      batch,
      quiz: quiz ? { _id: quiz._id, title: quiz.title, slug: quiz.slug, url: `/8qt/q/${quiz.slug}`, isDefault: quiz.isDefault } : null,
      message: `Imported ${inserted} questions. ${errors.length} errors.${quiz ? ` Quiz "${quiz.title}" created.` : ""}`
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message, errors });
  }
});

// ── Upload batches: every CSV import is stamped with a UUID (importBatch) ──
// GET /admin/8qt/questions/batches - list batches with counts + linked quiz
// NOTE: registered before any /questions/:id route so "batches" never
//       matches as an :id parameter.
router.get("/questions/batches", async (req, res) => {
  try {
    const batches = await EightQTQuestion.aggregate([
      { $match: { importBatch: { $ne: null } } },
      { $group: {
          _id: "$importBatch",
          total:  { $sum: 1 },
          active: { $sum: { $cond: ["$active", 1, 0] } },
          firstAt: { $min: "$createdAt" },
          quotients: { $addToSet: "$quotient" }
        }
      },
      { $sort: { firstAt: -1 } },
      { $limit: 50 }
    ]);
    // Attach the quiz created from each batch (if any)
    const quizByBatch = {};
    const quizzes = await EightQTQuiz.find({ importBatch: { $in: batches.map(b => b._id) } })
      .select("title slug importBatch isDefault active").lean();
    for (const q of quizzes) quizByBatch[q.importBatch] = q;
    for (const b of batches) b.quiz = quizByBatch[b._id] || null;
    res.json({ ok: true, batches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disable an entire upload batch in one click (soft delete)
// DELETE /admin/8qt/questions/batch/:batch
router.delete("/questions/batch/:batch", writeOnly, async (req, res) => {
  try {
    const r = await EightQTQuestion.updateMany(
      { importBatch: req.params.batch },
      { $set: { active: false } }
    );
    res.json({ ok: true, disabled: r.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single question with full options + scores (for admin preview drawer)
// GET /admin/8qt/questions/:id
router.get("/questions/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "bad id" });
    const question = await EightQTQuestion.findById(req.params.id).lean();
    if (!question) return res.status(404).json({ error: "Question not found" });
    res.json({ ok: true, question });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/questions", writeOnly, async (req, res) => {
  try {
    const q = await EightQTQuestion.create({
      ...req.body,
      createdBy: req.user._id
    });
    res.json({ ok: true, question: q });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/questions/:id", writeOnly, async (req, res) => {
  try {
    const q = await EightQTQuestion.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );
    if (!q) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, question: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/questions/:id", writeOnly, async (req, res) => {
  try {
    await EightQTQuestion.findByIdAndUpdate(req.params.id, { $set: { active: false } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ARCHETYPES
// ══════════════════════════════════════════════════════════════

router.get("/archetypes", async (req, res) => {
  const archetypes = await EightQTArchetype.find()
    .sort({ priority: -1 }).lean();
  res.json({ archetypes });
});

router.post("/archetypes", writeOnly, async (req, res) => {
  try {
    const arch = await EightQTArchetype.create(req.body);
    res.json({ ok: true, archetype: arch });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/archetypes/:id", writeOnly, async (req, res) => {
  try {
    const arch = await EightQTArchetype.findByIdAndUpdate(
      req.params.id, { $set: req.body }, { new: true }
    );
    if (!arch) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, archetype: arch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/archetypes/:id", writeOnly, async (req, res) => {
  try {
    await EightQTArchetype.findByIdAndUpdate(req.params.id, { $set: { active: false } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ARCHETYPE SEEDER - one per dominant quotient + default fallback
// POST /admin/8qt/archetypes/seed-defaults
// Idempotent: matches by name, updates if exists, creates if missing.
// Every finished attempt will land on the archetype whose quotient
// is that participant's HIGHEST score; ties break by displayOrder.
// ══════════════════════════════════════════════════════════════
router.post("/archetypes/seed-defaults", writeOnly, async (req, res) => {
  try {
    const seeds = [
      {
        name: "The Conscious Navigator", dominantQuotient: "CsQ", priority: 10,
        tagline: "Sees the whole board before making a move.",
        description: "Your strongest signal is Consciousness. You read situations, people and yourself with unusual clarity, noticing what others miss. Organisations rely on you for honest situational awareness - you are the early-warning system and the compass.",
        reflectionPrompts: [
          "Where has your awareness spotted a problem before anyone else - and did you act on it?",
          "Which blind spot do you suspect you still have, and who could help you see it?"
        ]
      },
      {
        name: "The Responsible Builder", dominantQuotient: "RQ", priority: 10,
        tagline: "Owns the outcome, not just the task.",
        description: "Your strongest signal is Responsibility. You take ownership where others take cover, and you finish what you start. Teams anchor on you because commitments made to you - and by you - actually land.",
        reflectionPrompts: [
          "What is one responsibility you carry that nobody formally assigned to you?",
          "Where might over-ownership be preventing others from growing?"
        ]
      },
      {
        name: "The Insightful Interpreter", dominantQuotient: "IQ", priority: 10,
        tagline: "Turns noise into meaning.",
        description: "Your strongest signal is Interpretation. You translate complexity - data, behaviour, ambiguity - into meaning others can act on. You are the bridge between what is happening and what it actually means.",
        reflectionPrompts: [
          "When did your reading of a situation change a decision for the better?",
          "Whose perspective do you least understand right now - and what would it take to interpret it fairly?"
        ]
      },
      {
        name: "The Purposeful Pathfinder", dominantQuotient: "PQ", priority: 10,
        tagline: "Knows why before deciding how.",
        description: "Your strongest signal is Purpose. Direction comes naturally to you - you connect daily work to a larger why, and you pull others toward it. Without people like you, effort scatters; with you, it converges.",
        reflectionPrompts: [
          "What purpose are you serving that you have never said out loud?",
          "Where are you busy but not aligned - and what would realignment cost?"
        ]
      },
      {
        name: "The Frequency Harmoniser", dominantQuotient: "FQ", priority: 10,
        tagline: "Tunes the energy of every room they enter.",
        description: "Your strongest signal is Frequencies. You sense and set the emotional wavelength of a group - calming turbulence, lifting flat energy, matching the moment. Culture forms around people like you.",
        reflectionPrompts: [
          "Which environments drain your frequency, and which amplify it?",
          "When did you last deliberately shift a room's energy - what did it make possible?"
        ]
      },
      {
        name: "The Civilisation Steward", dominantQuotient: "CvQ", priority: 10,
        tagline: "Builds things meant to outlast them.",
        description: "Your strongest signal is Civilization. You think in systems, institutions and legacy - what endures beyond the quarter, beyond the founder, beyond you. You are the keeper of standards and the architect of continuity.",
        reflectionPrompts: [
          "What are you building that should still exist in twenty years?",
          "Which tradition around you deserves protecting - and which deserves retiring?"
        ]
      },
      {
        name: "The Bridge Negotiator", dominantQuotient: "NQ", priority: 10,
        tagline: "Finds the deal inside the deadlock.",
        description: "Your strongest signal is Negotiation. You locate shared interest where others see only conflict, and you trade positions without trading trust. Progress that requires two unwilling parties usually requires you first.",
        reflectionPrompts: [
          "What is a conflict you resolved that nobody thanked you for?",
          "Where are you compromising too early instead of negotiating fully?"
        ]
      },
      {
        name: "The Technology Pioneer", dominantQuotient: "TQ", priority: 10,
        tagline: "Adopts tomorrow's tools today.",
        description: "Your strongest signal is Technology. You reach for leverage - tools, automation, new methods - before they are obvious, and you multiply what a team can do. You are the force that keeps an organisation from being outrun.",
        reflectionPrompts: [
          "Which manual process around you is quietly begging to be automated?",
          "What technology are you avoiding - and is that wisdom or comfort?"
        ]
      },
      {
        name: "The Emerging Thinker", dominantQuotient: null, priority: 0, isDefault: true,
        tagline: "At the beginning of a deliberate journey.",
        description: "Your profile shows balanced, early-stage signals across the eight quotients. This is not a verdict - it is a starting line. Retake the assessment as you grow and watch your dominant quotient reveal itself.",
        reflectionPrompts: [
          "Which of the eight quotients do you most want to strengthen this quarter?",
          "What would a 10% braver version of you do differently this week?"
        ]
      }
    ];

    let created = 0, updated = 0;
    for (const seed of seeds) {
      const existing = await EightQTArchetype.findOne({ name: seed.name });
      if (existing) {
        await EightQTArchetype.updateOne({ _id: existing._id }, { $set: { ...seed, active: true } });
        updated++;
      } else {
        await EightQTArchetype.create({ ...seed, active: true, conditions: [] });
        created++;
      }
    }

    res.json({ ok: true, created, updated, message: `Seeded archetypes: ${created} created, ${updated} updated.` });
  } catch (err) {
    console.error("[8qt archetype seed]", err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// CERTIFICATE TEMPLATE
// ══════════════════════════════════════════════════════════════

router.get("/template", async (req, res) => {
  const template = await EightQTCertTemplate.findOne({ active: true }).lean();
  res.json({ template });
});

router.post("/template", writeOnly, async (req, res) => {
  try {
    await EightQTCertTemplate.updateMany({}, { $set: { active: false } });
    const t = await EightQTCertTemplate.create({ ...req.body, active: true });
    res.json({ ok: true, template: t });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/template/:id", writeOnly, async (req, res) => {
  try {
    const t = await EightQTCertTemplate.findByIdAndUpdate(
      req.params.id, { $set: req.body }, { new: true }
    );
    res.json({ ok: true, template: t });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ANALYTICS
// GET /admin/8qt/analytics
// ══════════════════════════════════════════════════════════════
router.get("/analytics", async (req, res) => {
  try {
    const [
      total, finished, abandoned,
      anonymous, registered,
      certNone, certRequested, certPaid, certIssued
    ] = await Promise.all([
      EightQTAttempt.countDocuments(),
      EightQTAttempt.countDocuments({ status: "finished" }),
      EightQTAttempt.countDocuments({ status: "in_progress" }),
      EightQTAttempt.countDocuments({ userId: null }),
      EightQTAttempt.countDocuments({ userId: { $ne: null } }),
      EightQTAttempt.countDocuments({ certificateStatus: "none" }),
      EightQTAttempt.countDocuments({ certificateStatus: "requested" }),
      EightQTAttempt.countDocuments({ certificateStatus: "paid" }),
      EightQTAttempt.countDocuments({ certificateStatus: "issued" })
    ]);

    const quotientAverages = await EightQTAttempt.aggregate([
      { $match: { status: "finished" } },
      { $unwind: "$quotientScores" },
      { $group: {
          _id: "$quotientScores.code",
          name: { $first: "$quotientScores.name" },
          avg: { $avg: "$quotientScores.score" },
          count: { $sum: 1 }
        }
      },
      { $sort: { avg: 1 } }
    ]);

    const archetypeDist = await EightQTAttempt.aggregate([
      { $match: { status: "finished" } },
      { $group: { _id: "$archetypeName", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const sectorDist = await EightQTAttempt.aggregate([
      { $match: { "profile.sector": { $ne: "" } } },
      { $group: { _id: "$profile.sector", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const countryDist = await EightQTAttempt.aggregate([
      { $match: { "profile.country": { $ne: "" } } },
      { $group: { _id: "$profile.country", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dailyAttempts = await EightQTAttempt.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      summary: {
        total, finished, abandoned,
        anonymous, registered,
        certNone, certRequested, certPaid, certIssued,
        completionRate: total > 0 ? Math.round((finished / total) * 100) : 0,
        certConversionRate: finished > 0
          ? Math.round(((certRequested + certPaid + certIssued) / finished) * 100) : 0
      },
      quotientAverages,
      archetypeDist,
      sectorDist,
      countryDist,
      dailyAttempts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ATTEMPT LIST
// GET /admin/8qt/attempts
// ══════════════════════════════════════════════════════════════
router.get("/attempts", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 25;
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.certStatus) filter.certificateStatus = req.query.certStatus;

    const total = await EightQTAttempt.countDocuments(filter);
    const attempts = await EightQTAttempt.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("userId", "email displayName")
      .select("userId participantName participantCode archetypeName status certificateStatus certificatePdfUrl certificateVerifyCode certificateName certificateEmail dominantQuotient quotientScores profile createdAt finishedAt adminIssuedBy adminIssueNote")
      .lean();

    res.json({ attempts, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ATTEMPT SEARCH
// GET /admin/8qt/attempts/search?q=...&status=...&certStatus=...
// ══════════════════════════════════════════════════════════════
router.get("/attempts/search", async (req, res) => {
  try {
    const q = req.query.q?.trim() || "";
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 25;
    const filter = {};

    if (req.query.status)     filter.status = req.query.status;
    if (req.query.certStatus) filter.certificateStatus = req.query.certStatus;
    if (req.query.archetype)  filter.archetypeName = new RegExp(req.query.archetype, "i");

    if (q) {
      filter.$or = [
        { participantName:   new RegExp(q, "i") },
        { participantCode:   new RegExp(q, "i") },
        { certificateName:   new RegExp(q, "i") },
        { certificateEmail:  new RegExp(q, "i") },
        { archetypeName:     new RegExp(q, "i") },
        { "profile.country": new RegExp(q, "i") },
        { "profile.sector":  new RegExp(q, "i") }
      ];
    }

    const total = await EightQTAttempt.countDocuments(filter);
    const attempts = await EightQTAttempt.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("userId", "email displayName")
      .select("userId participantName participantCode archetypeName status certificateStatus certificatePdfUrl certificateVerifyCode certificateName certificateEmail dominantQuotient quotientScores profile createdAt finishedAt")
      .lean();

    res.json({ attempts, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ATTEMPT DETAIL - full quiz review with right/wrong per answer
// GET /admin/8qt/attempts/:id
// ══════════════════════════════════════════════════════════════
router.get("/attempts/:id", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.id)
      .populate("userId", "email displayName firstName lastName")
      .populate("archetypeId", "name tagline description reflectionPrompts")
      .lean();

    if (!attempt) return res.status(404).json({ error: "Attempt not found" });

    // Hydrate questions for all answered question IDs
    const questionIds = attempt.answers.map(a => a.questionId);
    const questions = await EightQTQuestion.find({ _id: { $in: questionIds } }).lean();
    const questionMap = {};
    for (const q of questions) questionMap[String(q._id)] = q;

    // Map answers by question ID for O(1) lookup
    const answerMap = {};
    for (const a of attempt.answers) {
      answerMap[String(a.questionId)] = a;
    }

    const reviewRows = [];

    for (let i = 0; i < attempt.questionIds.length; i++) {
      const qid    = String(attempt.questionIds[i]);
      const q      = questionMap[qid];
      if (!q) continue;

      const answer   = answerMap[qid] || null;
      const optOrder = attempt.optionsOrder?.[i] || q.options.map((_, idx) => idx);

      // Best option = highest points for this question's primary quotient
      const primaryQ = q.quotient;
      let bestOrigIdx = 0;
      let bestPts     = -1;
      for (let oi = 0; oi < q.options.length; oi++) {
        const pts = Number(q.options[oi].scores?.[primaryQ] || 0);
        if (pts > bestPts) { bestPts = pts; bestOrigIdx = oi; }
      }

      // Build display options in the order participant saw them
      const displayOptions = optOrder.map((origIdx, displayPos) => {
        const opt      = q.options[origIdx];
        const totalPts = Object.values(opt.scores || {}).reduce((s, v) => s + Number(v), 0);
        return {
          displayPos,
          origIdx,
          text:      opt.text,
          scores:    opt.scores,
          totalPoints: totalPts,
          isBest:    origIdx === bestOrigIdx,
          wasChosen: answer ? answer.selectedIndex === origIdx : false
        };
      });

      const earnedPts = answer
        ? Object.values(answer.scores || {}).reduce((s, v) => s + Number(v), 0)
        : 0;

      // Correct = chose the highest-scoring option for the primary quotient
      const isCorrect = answer ? answer.selectedIndex === bestOrigIdx : null;

      reviewRows.push({
        questionNumber: i + 1,
        questionId:  qid,
        quotient:    q.quotient,
        text:        q.text,
        isBlended:   q.isBlended,
        options:     displayOptions,
        skipped:     !answer,
        isCorrect,
        earnedPts,
        bestPts,
        chosenIndex: answer?.selectedIndex ?? null,
        chosenText:  answer != null ? (q.options[answer.selectedIndex]?.text ?? "-") : "Not answered"
      });
    }

    const answered  = reviewRows.filter(r => !r.skipped).length;
    const correct   = reviewRows.filter(r => r.isCorrect === true).length;
    const incorrect = reviewRows.filter(r => r.isCorrect === false).length;
    const accuracy  = answered > 0 ? Math.round((correct / answered) * 100) : 0;

    // Per-quotient accuracy breakdown
    const quotientBreakdown = {};
    for (const row of reviewRows) {
      if (!quotientBreakdown[row.quotient]) {
        quotientBreakdown[row.quotient] = { total: 0, correct: 0, skipped: 0 };
      }
      const qb = quotientBreakdown[row.quotient];
      qb.total++;
      if (row.skipped)        qb.skipped++;
      else if (row.isCorrect) qb.correct++;
    }

    res.json({
      attempt,
      reviewRows,
      summary:   { answered, correct, incorrect, accuracy },
      quotientBreakdown
    });
  } catch (err) {
    console.error("[admin attempt detail]", err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ADMIN CERTIFICATE PREVIEW
// Generates a PDF for any finished attempt without changing
// the participant's certificateStatus or payment flow.
// PDF goes to /certificates/8qt/preview/ subdirectory.

// ══════════════════════════════════════════════════════════════
// ADMIN CERTIFICATE PREVIEW
// Generates a PDF for any finished attempt without changing
// the participant's certificateStatus or payment flow.
//
// GET /admin/8qt/attempts/:id/preview-cert
// ══════════════════════════════════════════════════════════════
router.get("/attempts/:id/preview-cert", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.id);
    if (!attempt) return res.status(404).json({ error: "Attempt not found" });
    if (attempt.status !== "finished") {
      return res.status(400).json({ error: "Attempt not yet finished" });
    }

    // If already officially issued, return that PDF directly
    if (attempt.certificatePdfUrl && attempt.certificateStatus === "issued") {
      return res.json({
        ok: true,
        url: attempt.certificatePdfUrl,
        verifyCode: attempt.certificateVerifyCode,
        note: "returning existing issued certificate"
      });
    }

    const template  = await EightQTCertTemplate.findOne({ active: true }).lean();
    let archetype   = null;
    if (attempt.archetypeId) {
      archetype = await EightQTArchetype.findById(attempt.archetypeId).lean();
    }

    // Use the proper 8QT cert builder - NOT buildCertificateHtml from certificateTemplate.js
    const { url, verifyCode } = await generateEightQTCertPdf({
      attempt: attempt.toObject(),
      template,
      archetype
    });

    console.log(`[admin] Preview cert for attempt ${attempt._id}: ${url}`);
    res.json({ ok: true, url, verifyCode, note: "admin preview - participant payment status unchanged" });
  } catch (err) {
    console.error("[admin preview-cert]", err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// MANUAL CERTIFICATE ISSUANCE
// Issues a certificate for any finished attempt without payment.
// Use for: complimentary certs, researchers, VIPs, corrections.
// Writes adminIssuedBy + adminIssueNote for audit trail.
//
// POST /admin/8qt/attempts/:id/issue-cert
// Body: { fullName, email, orgName?, notes? }
// ══════════════════════════════════════════════════════════════
router.post("/attempts/:id/issue-cert", writeOnly, async (req, res) => {
  try {
    const { fullName, email, orgName, notes } = req.body;
    if (!fullName || !email) {
      return res.status(400).json({ error: "fullName and email are required" });
    }

    const attempt = await EightQTAttempt.findById(req.params.id);
    if (!attempt) return res.status(404).json({ error: "Attempt not found" });
    if (attempt.status !== "finished") {
      return res.status(400).json({ error: "Cannot issue certificate for unfinished attempt" });
    }

    // Write cert details to attempt before generating - the builder reads these
    attempt.certificateName  = fullName.trim();
    attempt.certificateEmail = email.trim().toLowerCase();
    attempt.certificateOrg   = orgName?.trim() || "";

    const template  = await EightQTCertTemplate.findOne({ active: true }).lean();
    let archetype   = null;
    if (attempt.archetypeId) {
      archetype = await EightQTArchetype.findById(attempt.archetypeId).lean();
    }

    const { url, verifyCode } = await generateEightQTCertPdf({
      attempt: attempt.toObject(),
      template,
      archetype
    });

    attempt.certificatePdfUrl     = url;
    attempt.certificateVerifyCode = verifyCode;
    attempt.certificateStatus     = "issued";
    attempt.certificateIssuedAt   = new Date();
    attempt.adminIssuedBy         = req.user._id;
    attempt.adminIssueNote        = notes?.trim() || "Manually issued by admin";

    await attempt.save();

    console.log(`[admin] Manual cert issued for attempt ${attempt._id} → ${url} by ${req.user.email}`);
    res.json({ ok: true, url, verifyCode, attemptId: attempt._id });
  } catch (err) {
    console.error("[admin issue-cert]", err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ADMIN RE-GENERATE CERT (for paid/requested/issued attempts)
// POST /admin/8qt/attempts/:id/regenerate-cert
// ══════════════════════════════════════════════════════════════
router.post("/attempts/:id/regenerate-cert", writeOnly, async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.id);
    if (!attempt) return res.status(404).json({ error: "Attempt not found" });
    if (!["paid", "requested", "issued"].includes(attempt.certificateStatus)) {
      return res.status(400).json({ error: "Attempt has not been paid for" });
    }

    const template  = await EightQTCertTemplate.findOne({ active: true }).lean();
    let archetype   = null;
    if (attempt.archetypeId) {
      archetype = await EightQTArchetype.findById(attempt.archetypeId).lean();
    }

    const { url, verifyCode } = await generateEightQTCertPdf({
      attempt: attempt.toObject(),
      template,
      archetype
    });

    attempt.certificatePdfUrl     = url;
    attempt.certificateVerifyCode = verifyCode;
    attempt.certificateStatus     = "issued";
    attempt.certificateIssuedAt   = new Date();
    await attempt.save();

    console.log(`[admin] Certificate re-generated for attempt ${attempt._id}: ${url}`);
    res.json({ ok: true, url, verifyCode });
  } catch (err) {
    console.error("[admin] regenerate-cert error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// CERT PIPELINE
// Finished participants without certificates, sorted by avg score.
// Use for targeted nudges or complimentary issuances.
//
// GET /admin/8qt/cert-pipeline?minScore=60&limit=50&certStatus=none
// ══════════════════════════════════════════════════════════════
router.get("/cert-pipeline", async (req, res) => {
  try {
    const minScore  = Number(req.query.minScore || 0);
    const limit     = Math.min(Number(req.query.limit || 50), 200);
    const certState = req.query.certStatus || "none";

    const matchStage = { status: "finished" };
    if (certState !== "all") matchStage.certificateStatus = certState;

    const pipeline = [
      { $match: matchStage },
      { $addFields: {
          overallScore: {
            $cond: {
              if:   { $gt: [{ $size: "$quotientScores" }, 0] },
              then: { $avg: "$quotientScores.score" },
              else: 0
            }
          }
        }
      },
      ...(minScore > 0 ? [{ $match: { overallScore: { $gte: minScore } } }] : []),
      { $sort: { overallScore: -1 } },
      { $limit: limit },
      { $project: {
          participantName:   1,
          participantCode:   1,
          certificateName:   1,
          certificateEmail:  1,
          archetypeName:     1,
          dominantQuotient:  1,
          overallScore:      1,
          quotientScores:    1,
          certificateStatus: 1,
          finishedAt:        1,
          "profile.sector":  1,
          "profile.country": 1
        }
      }
    ];

    const results = await EightQTAttempt.aggregate(pipeline);
    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// CSV EXPORT - all finished attempts
// GET /admin/8qt/export/csv
// ══════════════════════════════════════════════════════════════
router.get("/export/csv", async (req, res) => {
  try {
    const filter = { status: "finished" };
    if (req.query.certStatus) filter.certificateStatus = req.query.certStatus;

    const attempts = await EightQTAttempt.find(filter)
      .select("participantName participantCode certificateName certificateEmail certificateOrg archetypeName dominantQuotient developmentEdge quotientScores certificateStatus certificateIssuedAt finishedAt profile adminIssueNote")
      .lean();

    const quotientCodes = ["CsQ", "RQ", "IQ", "PQ", "FQ", "CvQ", "NQ", "TQ"];
    const headers = [
      "Participant Name", "Code", "Certificate Name", "Email", "Organisation",
      "Archetype", "Dominant Q", "Development Edge", "Cert Status",
      "Country", "Sector", "Finished At", "Cert Issued At", "Admin Note",
      ...quotientCodes.flatMap(c => [`${c} Score`, `${c} Band`])
    ];

    const rows = attempts.map(a => {
      const scoreMap = {};
      for (const s of (a.quotientScores || [])) scoreMap[s.code] = s;
      return [
        a.participantName || "",
        a.participantCode || "",
        a.certificateName || "",
        a.certificateEmail || "",
        a.certificateOrg || "",
        a.archetypeName || "",
        a.dominantQuotient || "",
        a.developmentEdge || "",
        a.certificateStatus || "",
        a.profile?.country || "",
        a.profile?.sector || "",
        a.finishedAt   ? new Date(a.finishedAt).toISOString().split("T")[0]        : "",
        a.certificateIssuedAt ? new Date(a.certificateIssuedAt).toISOString().split("T")[0] : "",
        a.adminIssueNote || "",
        ...quotientCodes.flatMap(c => [
          scoreMap[c]?.score ?? "",
          scoreMap[c]?.band  ?? ""
        ])
      ];
    });

    const csv = [headers, ...rows]
      .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="8qt-attempts-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// QUIZZES  (dynamic size + fixed titled quizzes)
// ══════════════════════════════════════════════════════════════

// List quizzes (+ bank size per quotient, for the builder UI)
// GET /admin/8qt/quizzes
router.get("/quizzes", async (req, res) => {
  try {
    const quizzes = await EightQTQuiz.find().sort({ isDefault: -1, updatedAt: -1 }).lean();
    // enrich fixed quizzes with a live count of still-active questions
    for (const q of quizzes) {
      if (q.mode === "fixed") {
        q.liveCount = await EightQTQuestion.countDocuments({ _id: { $in: q.questionIds || [] }, active: true });
      }
    }
    const bankByQuotient = await EightQTQuestion.aggregate([
      { $match: { active: true } },
      { $group: { _id: "$quotient", count: { $sum: 1 } } }
    ]);
    res.json({ ok: true, quizzes, bankByQuotient });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single quiz (for editing)
// GET /admin/8qt/quizzes/:id
router.get("/quizzes/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "bad id" });
    const quiz = await EightQTQuiz.findById(req.params.id)
      .populate("questionIds", "text quotient active")
      .lean();
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    res.json({ ok: true, quiz });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Quiz PREVIEW (dry run) ──────────────────────────────────────────
// Simulates exactly what a participant would be served, WITHOUT creating
// an attempt. Fixed quizzes return the curated set; dynamic quizzes run a
// real draw (hit "Redraw" in the UI to see another sample). Options are
// returned with their score maps and the best-scoring option flagged.
// GET /admin/8qt/quizzes/:id/preview
router.get("/quizzes/:id/preview", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "bad id" });
    const quiz = await EightQTQuiz.findById(req.params.id).lean();
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    const shuffle = arr => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    let questions = [];
    if (quiz.mode === "fixed") {
      const ids = (quiz.questionIds || []).map(String);
      const docs = await EightQTQuestion.find({ _id: { $in: ids } }).lean();
      const byId = {};
      for (const d of docs) byId[String(d._id)] = d;
      questions = ids.map(id => byId[id]).filter(Boolean); // admin order
    } else {
      const size = Math.max(1, Number(quiz.size) || 8);
      const activeCodes = (quiz.quotients && quiz.quotients.length)
        ? quiz.quotients
        : (await EightQTConfig.find({ active: true }).lean()).map(c => c.code);
      if (quiz.drawStrategy === "random") {
        const pool = await EightQTQuestion.find({ quotient: { $in: activeCodes }, active: true }).lean();
        questions = shuffle(pool).slice(0, size);
      } else {
        const codes = shuffle([...activeCodes]);
        const base = Math.floor(size / codes.length);
        let rem = size - base * codes.length;
        const counts = codes.map(() => base + (rem-- > 0 ? 1 : 0));
        const buckets = await Promise.all(codes.map(async (code, i) => {
          if (counts[i] <= 0) return [];
          const pool = await EightQTQuestion.find({ quotient: code, active: true }).lean();
          return shuffle(pool).slice(0, counts[i]);
        }));
        questions = shuffle(buckets.flat());
      }
    }

    // Flag the best option per question (highest points toward its primary quotient)
    const preview = questions.map((q, n) => {
      let bestIdx = 0, bestPts = -1;
      (q.options || []).forEach((opt, oi) => {
        const pts = Number(opt.scores?.[q.quotient] || 0);
        if (pts > bestPts) { bestPts = pts; bestIdx = oi; }
      });
      return {
        n: n + 1,
        _id: q._id,
        quotient: q.quotient,
        isBlended: q.isBlended,
        active: q.active,
        text: q.text,
        options: (q.options || []).map((opt, oi) => ({
          text: opt.text, scores: opt.scores || {}, isBest: oi === bestIdx
        }))
      };
    });

    res.json({
      ok: true,
      quiz: {
        _id: quiz._id, title: quiz.title, slug: quiz.slug, mode: quiz.mode,
        size: quiz.size, drawStrategy: quiz.drawStrategy, isDefault: quiz.isDefault,
        retakeDays: quiz.retakeDays || 0, maxAttemptsPerPerson: quiz.maxAttemptsPerPerson || 0,
        avoidRepeatQuestions: quiz.avoidRepeatQuestions !== false,
        opensAt: quiz.opensAt, closesAt: quiz.closesAt
      },
      count: preview.length,
      questions: preview
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create
// POST /admin/8qt/quizzes  { title, mode, size, drawStrategy, quotients[], questionIds[], shuffleQuestions, shuffleOptions, active, isDefault }
router.post("/quizzes", writeOnly, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    const doc = {
      title: String(body.title).trim(),
      description: body.description || "",
      mode: body.mode === "fixed" ? "fixed" : "dynamic",
      size: Math.max(1, Number(body.size) || 8),
      drawStrategy: body.drawStrategy === "random" ? "random" : "even",
      quotients: Array.isArray(body.quotients) ? body.quotients : [],
      questionIds: Array.isArray(body.questionIds) ? body.questionIds : [],
      shuffleQuestions: body.shuffleQuestions !== false && body.shuffleQuestions !== "false",
      shuffleOptions:   body.shuffleOptions   !== false && body.shuffleOptions   !== "false",
      retakeDays:           Math.max(0, Number(body.retakeDays) || 0),
      maxAttemptsPerPerson: Math.max(0, Number(body.maxAttemptsPerPerson) || 0),
      avoidRepeatQuestions: body.avoidRepeatQuestions !== false && body.avoidRepeatQuestions !== "false",
      opensAt:  body.opensAt  ? new Date(body.opensAt)  : null,
      closesAt: body.closesAt ? new Date(body.closesAt) : null,
      active: body.active !== false && body.active !== "false",
      isDefault: !!body.isDefault && body.isDefault !== "false",
      createdBy: req.user._id
    };
    if (body.slug) doc.slug = String(body.slug).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const quiz = await EightQTQuiz.create(doc);
    // Only one default at a time
    if (quiz.isDefault) {
      await EightQTQuiz.updateMany({ _id: { $ne: quiz._id } }, { $set: { isDefault: false } });
    }
    res.json({ ok: true, quiz });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A quiz with that slug already exists" });
    res.status(500).json({ error: err.message });
  }
});

// Update
// PATCH /admin/8qt/quizzes/:id
router.patch("/quizzes/:id", writeOnly, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "bad id" });
    const allowed = ["title", "description", "mode", "size", "drawStrategy",
      "quotients", "questionIds", "shuffleQuestions", "shuffleOptions", "active", "isDefault", "slug",
      "retakeDays", "maxAttemptsPerPerson", "avoidRepeatQuestions", "opensAt", "closesAt"];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    if (update.size !== undefined) update.size = Math.max(1, Number(update.size) || 8);
    if (update.retakeDays !== undefined) update.retakeDays = Math.max(0, Number(update.retakeDays) || 0);
    if (update.maxAttemptsPerPerson !== undefined) update.maxAttemptsPerPerson = Math.max(0, Number(update.maxAttemptsPerPerson) || 0);
    if (update.opensAt  !== undefined) update.opensAt  = update.opensAt  ? new Date(update.opensAt)  : null;
    if (update.closesAt !== undefined) update.closesAt = update.closesAt ? new Date(update.closesAt) : null;
    if (update.slug) update.slug = String(update.slug).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

    const quiz = await EightQTQuiz.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    if (update.isDefault === true || update.isDefault === "true") {
      await EightQTQuiz.updateMany({ _id: { $ne: quiz._id } }, { $set: { isDefault: false } });
    }
    res.json({ ok: true, quiz });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A quiz with that slug already exists" });
    res.status(500).json({ error: err.message });
  }
});

// Set default (unset the rest)
// POST /admin/8qt/quizzes/:id/default
router.post("/quizzes/:id/default", writeOnly, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "bad id" });
    const quiz = await EightQTQuiz.findByIdAndUpdate(
      req.params.id, { $set: { isDefault: true, active: true } }, { new: true }
    );
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    await EightQTQuiz.updateMany({ _id: { $ne: quiz._id } }, { $set: { isDefault: false } });
    res.json({ ok: true, quiz });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete
// DELETE /admin/8qt/quizzes/:id
router.delete("/quizzes/:id", writeOnly, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "bad id" });
    await EightQTQuiz.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;