// routes/eightQTAdmin.js
// Admin panel for the 8 Quotients Test:
//   - Quotient config (active, question count, descriptions)
//   - Question bank (CSV upload + inline edit)
//   - Archetype management
//   - Certificate template config
//   - Analytics dashboard

import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse";
import fs from "fs";
import crypto from "crypto";
import { ensureAuth } from "../middleware/authGuard.js";
import EightQTConfig from "../models/eightQTConfig.js";
import EightQTQuestion from "../models/eightQTQuestion.js";
import EightQTArchetype from "../models/eightQTArchetype.js";
import EightQTCertTemplate from "../models/eightQTCertTemplate.js";
import EightQTAttempt from "../models/eightQTAttempt.js";

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

    // Average per quotient
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

    // Top archetypes
    const archetypeAgg = await EightQTAttempt.aggregate([
      { $match: { status: "finished", archetypeName: { $ne: null } } },
      { $group: { _id: "$archetypeName", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    // Cert conversion
    const certRequested = await EightQTAttempt.countDocuments({ certificateStatus: { $ne: "none" } });

    res.render("8qt/admin/panel", {
      configs,
      template,
      stats: {
        totalAttempts,
        finished,
        certIssued,
        certPaid,
        certRequested,
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

// GET /admin/8qt/config - list
router.get("/config", async (req, res) => {
  const configs = await EightQTConfig.find().sort({ displayOrder: 1 }).lean();
  res.json({ configs });
});

// POST /admin/8qt/config/seed - seed defaults if none exist
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

// PATCH /admin/8qt/config/:code - update one quotient
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

// GET /admin/8qt/questions?quotient=RQ&page=1
router.get("/questions", async (req, res) => {
  try {
    const filter = {};
    if (req.query.quotient) filter.quotient = req.query.quotient;
    if (req.query.active !== undefined) filter.active = req.query.active === "true";

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
    if (results.length > 0) {
      const docs = await EightQTQuestion.insertMany(results, { ordered: false });
      inserted = docs.length;
    }

    // Cleanup temp file
    fs.unlink(req.file.path, () => {});

    res.json({
      ok: true,
      inserted,
      errors,
      batch,
      message: `Imported ${inserted} questions. ${errors.length} errors.`
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message, errors });
  }
});

// POST /admin/8qt/questions - create single question
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

// PATCH /admin/8qt/questions/:id
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

// DELETE /admin/8qt/questions/:id - soft delete (sets active: false)
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
// CERTIFICATE TEMPLATE
// ══════════════════════════════════════════════════════════════

router.get("/template", async (req, res) => {
  const template = await EightQTCertTemplate.findOne({ active: true }).lean();
  res.json({ template });
});

router.post("/template", writeOnly, async (req, res) => {
  try {
    // Deactivate existing active templates
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

    // Avg per quotient
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

    // Archetype distribution
    const archetypeDist = await EightQTAttempt.aggregate([
      { $match: { status: "finished" } },
      { $group: { _id: "$archetypeName", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Sector distribution
    const sectorDist = await EightQTAttempt.aggregate([
      { $match: { "profile.sector": { $ne: "" } } },
      { $group: { _id: "$profile.sector", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Country distribution
    const countryDist = await EightQTAttempt.aggregate([
      { $match: { "profile.country": { $ne: "" } } },
      { $group: { _id: "$profile.country", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Daily attempts last 30 days
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
// ATTEMPT MANAGEMENT
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
      .select("userId participantName participantCode archetypeName status certificateStatus certificatePdfUrl certificateVerifyCode certificateName certificateEmail dominantQuotient quotientScores createdAt finishedAt")
      .lean();

    res.json({ attempts, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: manually regenerate a certificate (for "paid" but not yet "issued")
// POST /admin/8qt/attempts/:id/regenerate-cert
router.post("/attempts/:id/regenerate-cert", writeOnly, async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.id);
    if (!attempt) return res.status(404).json({ error: "Attempt not found" });
    if (!["paid", "requested", "issued"].includes(attempt.certificateStatus)) {
      return res.status(400).json({ error: "Attempt has not been paid for" });
    }

    const template = await EightQTCertTemplate.findOne({ active: true }).lean();
    let archetype = null;
    if (attempt.archetypeId) {
      archetype = await EightQTArchetype.findById(attempt.archetypeId).lean();
    }

    // Inline cert generation using existing green CRIPFCnt template
    const { buildCertificateHtml } = await import("../utils/certificateTemplate.js");
    const puppeteer = (await import("puppeteer")).default;
    const pathMod = (await import("path")).default;
    const fsMod = (await import("fs")).default;
    const cryptoMod = (await import("crypto")).default;

    const verifyCode = attempt.certificateVerifyCode ||
      cryptoMod.randomBytes(6).toString("hex").toUpperCase();

    const participantName = attempt.certificateName || attempt.participantName || "Participant";
    const scores = attempt.quotientScores || [];
    const dom = scores.find(s => s.code === attempt.dominantQuotient);
    const domScore = dom ? dom.score : null;

    const html = buildCertificateHtml({
      name: participantName,
      orgName: "CRIPFCnt",
      moduleName: attempt.dominantQuotient ? `${attempt.dominantQuotient} - Dominant Quotient` : "Placement Intelligence",
      quizTitle: attempt.archetypeName || "8 Quotients Assessment",
      score: domScore,
      percentage: domScore,
      date: new Date()
    });

    const outDir = pathMod.join(process.cwd(), "public", "certificates", "8qt");
    if (!fsMod.existsSync(outDir)) fsMod.mkdirSync(outDir, { recursive: true });
    const filename = `8qt-cert-${verifyCode}.pdf`;
    const outputPath = pathMod.join(outDir, filename);

    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({ path: outputPath, format: "A4", landscape: true, printBackground: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
    await browser.close();

    const url = `/certificates/8qt/${filename}`;

    attempt.certificatePdfUrl = url;
    attempt.certificateVerifyCode = verifyCode;
    attempt.certificateStatus = "issued";
    attempt.certificateIssuedAt = new Date();
    await attempt.save();

    console.log(`[admin] ✅ Certificate re-generated for attempt ${attempt._id}: ${url}`);
    res.json({ ok: true, url, verifyCode });
  } catch (err) {
    console.error("[admin] regenerate-cert error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
