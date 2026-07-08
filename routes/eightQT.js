// routes/eightQT.js
// Public-facing 8 Quotients Test routes:
//   Step 1: Landing page
//   Step 2: Identity selection (Google / Anonymous / Return with code)
//   Step 3: Optional pre-test profile
//   Step 4: The test (one question at a time)
//   Step 5: Submit + score
//   Step 6: Results page
//   Step 7: Certificate request form
//   Step 8: Stripe checkout initiation
//   Step 9: Verification public URL

import { Router } from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import Stripe from "stripe";
import EightQTConfig from "../models/eightQTConfig.js";
import EightQTQuiz from "../models/eightQTQuiz.js";
import EightQTQuestion from "../models/eightQTQuestion.js";
import EightQTAttempt from "../models/eightQTAttempt.js";
import EightQTArchetype from "../models/eightQTArchetype.js";
import EightQTCertTemplate from "../models/eightQTCertTemplate.js";
import EightQTCertPurchase from "../models/eightQTCertPurchase.js";
import User from "../models/user.js";
// ── Scoring functions (inlined - no external service file needed) ──

function getBand(score) {
  if (score >= 81) return "Recalibrative";
  if (score >= 61) return "Structural";
  if (score >= 41) return "Functional";
  if (score >= 21) return "Developing";
  return "Emerging";
}

// quotientMax (optional): { CsQ: 24, RQ: 6, ... } = max achievable per quotient
// for THIS attempt's served questions. When present it is the correct denominator
// regardless of quiz size/mode. When absent (legacy attempts) we fall back to the
// old questionCount*3 assumption so historical scoring is unchanged.
function computeQuotientScores(answers, configs, quotientMax = null) {
  const rawMap = {};
  for (const cfg of configs) {
    rawMap[cfg.code] = { earned: 0, name: cfg.name, questionCount: cfg.questionCount };
  }
  for (const answer of answers) {
    const qScores = answer.scores || {};
    for (const [code, pts] of Object.entries(qScores)) {
      if (!rawMap[code]) rawMap[code] = { earned: 0, name: code, questionCount: 8 };
      rawMap[code].earned += Number(pts) || 0;
    }
  }
  return configs.map(cfg => {
    const data = rawMap[cfg.code] || { earned: 0, name: cfg.name, questionCount: cfg.questionCount };
    const storedMax = quotientMax && Number.isFinite(Number(quotientMax[cfg.code]))
      ? Number(quotientMax[cfg.code])
      : null;
    const maxPossible = storedMax != null
      ? storedMax
      : (data.questionCount || cfg.questionCount || 8) * 3;
    const pct = maxPossible > 0 ? Math.round((data.earned / maxPossible) * 100) : 0;
    const clamped = Math.min(100, Math.max(0, pct));
    return { code: cfg.code, name: cfg.name, raw: data.earned, max: maxPossible, score: clamped, band: getBand(clamped) };
  });
}

// Max points each quotient can earn from a given set of questions (per-question
// best option toward that code, summed). Handles blended questions and any size.
function computeQuotientMax(questions) {
  const max = {};
  for (const q of questions || []) {
    const perCode = {};
    for (const opt of (q.options || [])) {
      for (const [code, pts] of Object.entries(opt.scores || {})) {
        const p = Number(pts) || 0;
        if (p > (perCode[code] || 0)) perCode[code] = p;
      }
    }
    for (const [code, p] of Object.entries(perCode)) max[code] = (max[code] || 0) + p;
  }
  return max;
}

async function matchArchetype(quotientScores) {
  const archetypes = await EightQTArchetype.find({ active: true }).sort({ priority: -1 }).lean();
  const scoreMap = {};
  for (const s of quotientScores) scoreMap[s.code] = s.score;
  for (const arch of archetypes) {
    if (arch.isDefault) continue;
    const allMatch = (arch.conditions || []).every(cond => {
      const val = scoreMap[cond.quotient] ?? 0;
      switch (cond.operator) {
        case "gte": return val >= cond.value;
        case "lte": return val <= cond.value;
        case "gt":  return val >  cond.value;
        case "lt":  return val <  cond.value;
        case "between": return val >= cond.value && val <= (cond.value2 ?? 100);
        default: return false;
      }
    });
    if (allMatch) return arch;
  }
  return archetypes.find(a => a.isDefault) || null;
}

function getDominantAndEdge(quotientScores) {
  if (!quotientScores.length) return { dominant: null, edge: null };
  const sorted = [...quotientScores].sort((a, b) => b.score - a.score);
  return { dominant: sorted[0].code, edge: sorted[sorted.length - 1].code };
}

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── Helpers ─────────────────────────────────────────────────────────

function generateParticipantCode() {
  const adjectives = ["AMBER", "COBALT", "EMBER", "FERN", "JADE", "IVORY",
    "LUNAR", "NOVA", "ONYX", "PEARL", "SAGE", "SOLAR", "TERRA", "ZINC"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `PIQ-${num}-${adj}`;
}

function generateDisplayName(participantCode) {
  const parts = participantCode.split("-"); // PIQ-2847-Amber
  return `Thinker-${parts[2]}-${parts[1]}`;
}

/** Shuffle array in place */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Build the full question set based on active quotient configs */
async function buildQuestionSet(configs) {
  const allQuestions = [];
  for (const cfg of configs) {
    if (!cfg.active) continue;
    const questions = await EightQTQuestion.find({
      quotient: cfg.code,
      active: true
    }).lean();

    // Shuffle and pick questionCount
    const shuffled = shuffle([...questions]);
    const selected = shuffled.slice(0, cfg.questionCount);
    allQuestions.push(...selected);
  }
  // Mix across quotients so they're not in quotient blocks from participant's perspective
  return shuffle(allQuestions);
}

/** Spread `total` across `buckets` as evenly as possible, e.g. (8,8)->all 1s */
function distribute(total, buckets) {
  if (buckets <= 0) return [];
  const base = Math.floor(total / buckets);
  let rem = total - base * buckets;
  return Array.from({ length: buckets }, () => base + (rem-- > 0 ? 1 : 0));
}

/**
 * Resolve which quiz to use.
 *  - explicit id/slug (from ?quiz=, /q/:slug, or session) wins
 *  - else the quiz flagged isDefault
 *  - else null  -> caller falls back to legacy per-quotient behaviour
 */
async function resolveActiveQuiz(ref) {
  if (ref) {
    if (mongoose.isValidObjectId(ref)) {
      const byId = await EightQTQuiz.findOne({ _id: ref, active: true }).lean();
      if (byId) return byId;
    }
    const bySlug = await EightQTQuiz.findOne({ slug: String(ref).toLowerCase(), active: true }).lean();
    if (bySlug) return bySlug;
  }
  return await EightQTQuiz.findOne({ isDefault: true, active: true }).lean();
}

/**
 * Assemble the served questions for one attempt from a quiz.
 * Reshuffles every call, so each attempt is fresh.
 * Returns the ordered questions array (full docs).
 */
async function buildQuizQuestionSet(quiz, configs) {
  // No quiz configured anywhere -> original behaviour, untouched.
  if (!quiz) return await buildQuestionSet(configs);

  let selected = [];

  if (quiz.mode === "fixed") {
    const ids = (quiz.questionIds || []).map(String);
    if (ids.length) {
      const docs = await EightQTQuestion.find({ _id: { $in: ids }, active: true }).lean();
      const byId = {};
      for (const d of docs) byId[String(d._id)] = d;
      selected = ids.map(id => byId[id]).filter(Boolean); // preserve admin order
    }
    if (quiz.shuffleQuestions !== false) selected = shuffle([...selected]);
    return selected;
  }

  // dynamic
  const size = Math.max(1, Number(quiz.size) || 8);
  const activeCodes = (quiz.quotients && quiz.quotients.length)
    ? quiz.quotients
    : configs.filter(c => c.active).map(c => c.code);

  if (quiz.drawStrategy === "random") {
    const pool = await EightQTQuestion.find({ quotient: { $in: activeCodes }, active: true }).lean();
    selected = shuffle(pool).slice(0, size);
  } else {
    // "even": spread size across quotients; shuffle which quotients get the extras
    const codesShuffled = shuffle([...activeCodes]);
    const counts = distribute(size, codesShuffled.length);
    const buckets = await Promise.all(codesShuffled.map(async (code, i) => {
      if (counts[i] <= 0) return [];
      const pool = await EightQTQuestion.find({ quotient: code, active: true }).lean();
      return shuffle(pool).slice(0, counts[i]);
    }));
    selected = buckets.flat();
  }

  if (quiz.shuffleQuestions !== false) selected = shuffle(selected);
  return selected;
}

// ══════════════════════════════════════════════════════════════
// STEP 1 - LANDING PAGE
// GET /8qt
// ══════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const configs = await EightQTConfig.find({ active: true })
      .sort({ displayOrder: 1 }).lean();

    // If a quiz was linked via ?quiz=, remember it for this session
    if (req.query.quiz && req.session) {
      req.session.eightQTQuizId = String(req.query.quiz);
      await req.session.save();
    }

    // Reflect the quiz that will actually be served (default or session pick).
    // Falls back to the legacy per-quotient total when no quiz exists.
    const quiz = await resolveActiveQuiz(req.session?.eightQTQuizId || null);
    let totalQuestions;
    if (quiz && quiz.mode === "fixed") {
      totalQuestions = (quiz.questionIds || []).length;
    } else if (quiz) {
      totalQuestions = Math.max(1, Number(quiz.size) || 8);
    } else {
      totalQuestions = configs.reduce((sum, c) => sum + c.questionCount, 0);
    }
    const estimatedMinutes = Math.ceil(totalQuestions * 0.75); // ~45s per question

    // If already logged in and has an in-progress attempt, offer to resume
    let resumeCode = null;
    if (req.user) {
      const ongoing = await EightQTAttempt.findOne({
        userId: req.user._id,
        status: "in_progress"
      }).lean();
      if (ongoing) resumeCode = ongoing._id;
    }

    res.render("8qt/landing", {
      configs,
      totalQuestions,
      estimatedMinutes,
      resumeCode,
      quiz: quiz || null,
      user: req.user || null
    });
  } catch (err) {
    console.error("[8qt landing]", err);
    res.status(500).send("Error loading page");
  }
});

// ══════════════════════════════════════════════════════════════
// ENTRY: Select a titled quiz, then go through the normal flow.
// GET /8qt/q/:slug  (shareable link for fixed / named quizzes)
// ══════════════════════════════════════════════════════════════
router.get("/q/:slug", async (req, res) => {
  try {
    const quiz = await EightQTQuiz.findOne({
      slug: String(req.params.slug || "").toLowerCase(),
      active: true
    }).lean();
    if (!quiz) return res.status(404).render("8qt/error", { message: "Quiz not found." });

    // Remember the choice for POST /profile
    if (req.session) {
      req.session.eightQTQuizId = String(quiz._id);
      await req.session.save();
    }
    return res.redirect("/8qt");
  } catch (err) {
    console.error("[8qt quiz entry]", err);
    return res.status(500).render("8qt/error", { message: "Error opening quiz." });
  }
});

// ══════════════════════════════════════════════════════════════
// STEP 2 - IDENTITY: Anonymous start
// POST /8qt/start/anonymous
// ══════════════════════════════════════════════════════════════
router.post("/start/anonymous", async (req, res) => {
  try {
    let code;
    // Ensure unique code
    for (let i = 0; i < 10; i++) {
      const candidate = generateParticipantCode();
      const exists = await EightQTAttempt.findOne({ participantCode: candidate }).lean();
      if (!exists) { code = candidate; break; }
    }
    if (!code) code = `PIQ-${Date.now()}-X`;

    // Store in session so they can continue
    req.session.eightQTParticipantCode = code;
    await req.session.save();

    res.json({ ok: true, participantCode: code, redirect: `/8qt/profile?code=${code}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// STEP 2 - IDENTITY: Return with code
// POST /8qt/resume
router.post("/resume", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Code required" });

    // Normalise - codes stored uppercase, user may type any case
    const normCode = code.trim().toUpperCase();
    const attempt = await EightQTAttempt.findOne({ participantCode: new RegExp("^" + normCode + "$", "i") }).lean();
    if (!attempt) return res.status(404).json({ error: "Code not found. Please check and try again." });

    req.session.eightQTParticipantCode = normCode;
    await req.session.save();

    if (attempt.status === "finished") {
      return res.json({ ok: true, redirect: `/8qt/results/${attempt._id}` });
    }
    return res.json({ ok: true, redirect: `/8qt/test/${attempt._id}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// STEP 2 - IDENTITY: Google (existing auth infrastructure)
// GET /8qt/google - sets session marker and redirects to /auth/google
router.get("/google", (req, res) => {
  req.session.signupSource = "8qt";
  req.session.returnTo = "/8qt/profile";
  req.session.save(() => res.redirect("/auth/google"));
});

// ══════════════════════════════════════════════════════════════
// STEP 3 - PRE-TEST OPTIONAL PROFILE
// GET  /8qt/profile
// POST /8qt/profile
// ══════════════════════════════════════════════════════════════
router.get("/profile", (req, res) => {
  const code = req.query.code || req.session?.eightQTParticipantCode || null;
  res.render("8qt/profile", { code, user: req.user || null });
});

router.post("/profile", async (req, res) => {
  try {
    const { firstName, country, sector, code } = req.body;

    // Attempt creation happens here - after we have profile data
    const configs = await EightQTConfig.find({ active: true })
      .sort({ displayOrder: 1 }).lean();

    if (!configs.length) {
      return res.status(400).json({ error: "Test not yet configured. Please check back soon." });
    }

    // Resolve which quiz to serve: explicit pick -> session -> default -> legacy
    const quizRef = req.body.quiz || req.query.quiz || req.session?.eightQTQuizId || null;
    const quiz = await resolveActiveQuiz(quizRef);

    const questions = await buildQuizQuestionSet(quiz, configs);
    if (!questions.length) {
      return res.status(400).json({ error: "No questions available yet. Please check back soon." });
    }

    // Per-quotient max for THIS served set (correct denominator for any size/mode)
    const quotientMax = computeQuotientMax(questions);

    // Build options order. Honour the quiz's shuffleOptions (default: shuffle).
    const optionsOrder = questions.map(q =>
      (quiz && quiz.shuffleOptions === false)
        ? [...Array(q.options.length).keys()]
        : shuffle([...Array(q.options.length).keys()])
    );

    // Generate participant code if anonymous
    let participantCode = code || req.session?.eightQTParticipantCode || null;
    let userId = req.user?._id || null;

    // If Google-authed user, no participantCode needed
    if (userId) participantCode = null;

    // If anonymous, ensure code exists
    if (!userId && !participantCode) {
      for (let i = 0; i < 10; i++) {
        const c = generateParticipantCode();
        const exists = await EightQTAttempt.findOne({ participantCode: c }).lean();
        if (!exists) { participantCode = c; break; }
      }
    }

    const displayName = participantCode ? generateDisplayName(participantCode) : null;

    // Build attempt doc - omit participantCode entirely for Google users
    // (sparse index ignores absent fields, but fails on explicit null duplicates)
    const attemptDoc = {
      userId,
      participantName: displayName,
      profile: {
        firstName: firstName?.trim() || "",
        country: country?.trim() || "",
        sector: sector?.trim() || ""
      },
      questionIds: questions.map(q => q._id),
      optionsOrder,
      quizId: quiz?._id || null,
      quizTitle: quiz?.title || null,
      quotientMax,
      status: "in_progress",
      startedAt: new Date(),
      attemptIp: req.ip,
      referrer: req.get("referer") || null
    };
    if (participantCode) attemptDoc.participantCode = participantCode;
    const attempt = await EightQTAttempt.create(attemptDoc);

    // Store attempt ID in session
    if (req.session) {
      req.session.eightQTAttemptId = String(attempt._id);
      if (participantCode) req.session.eightQTParticipantCode = participantCode;
      await req.session.save();
    }

    res.json({
      ok: true,
      attemptId: attempt._id,
      participantCode,
      redirect: `/8qt/test/${attempt._id}`
    });
  } catch (err) {
    console.error("[8qt profile/create]", err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// STEP 4 - THE TEST
// GET /8qt/test/:attemptId
// ══════════════════════════════════════════════════════════════
router.get("/test/:attemptId", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.attemptId)
      .populate("questionIds")
      .lean();

    if (!attempt) return res.status(404).render("8qt/error", { message: "Test session not found." });
    if (attempt.status === "finished") return res.redirect(`/8qt/results/${attempt._id}`);

    // Security: only the owner can access
    const sessionCode = req.session?.eightQTParticipantCode;
    const sessionAttemptId = req.session?.eightQTAttemptId;
    const isOwner =
      (req.user && attempt.userId && String(attempt.userId) === String(req.user._id)) ||
      (sessionCode && attempt.participantCode === sessionCode) ||
      (sessionAttemptId && String(attempt._id) === sessionAttemptId);

    if (!isOwner) return res.status(403).render("8qt/error", { message: "Access denied." });

    // Figure out which question to show (first unanswered)
    const answeredIds = new Set(attempt.answers.map(a => String(a.questionId)));
    const questions = attempt.questionIds; // populated
    const currentIndex = questions.findIndex(q => !answeredIds.has(String(q._id)));

    if (currentIndex === -1) {
      // All answered - push to submit
      return res.redirect(`/8qt/submit/${attempt._id}`);
    }

    const currentQ = questions[currentIndex];
    // Apply randomised option order for this question
    const optOrder = attempt.optionsOrder[currentIndex] || currentQ.options.map((_, i) => i);
    const shuffledOptions = optOrder.map(i => ({ ...currentQ.options[i], originalIndex: i }));

    res.render("8qt/test", {
      attempt: { _id: attempt._id, participantCode: attempt.participantCode },
      question: {
        _id: currentQ._id,
        text: currentQ.text,
        options: shuffledOptions
      },
      currentIndex,
      totalQuestions: questions.length,
      progress: Math.round((currentIndex / questions.length) * 100),
      answeredCount: answeredIds.size
    });
  } catch (err) {
    console.error("[8qt test get]", err);
    res.status(500).render("8qt/error", { message: "Error loading question." });
  }
});

// POST /8qt/test/:attemptId/answer - save one answer, redirect to next
router.post("/test/:attemptId/answer", async (req, res) => {
  try {
    const { questionId, selectedIndex } = req.body;
    if (!questionId || selectedIndex === undefined) {
      return res.status(400).json({ error: "Missing answer data" });
    }

    const attempt = await EightQTAttempt.findById(req.params.attemptId);
    if (!attempt || attempt.status === "finished") {
      return res.status(400).json({ error: "Invalid attempt" });
    }

    // Already answered this question?
    const alreadyAnswered = attempt.answers.find(
      a => String(a.questionId) === String(questionId)
    );
    if (alreadyAnswered) {
      return res.json({ ok: true, redirect: `/8qt/test/${attempt._id}` });
    }

    // Load question to get scores for selected option
    const question = await EightQTQuestion.findById(questionId).lean();
    if (!question) return res.status(404).json({ error: "Question not found" });

    const idx = Number(selectedIndex);
    // selectedIndex is the SHUFFLED index; resolve back to original
    const qIndex = attempt.questionIds.findIndex(
      id => String(id) === String(questionId)
    );
    const optOrder = attempt.optionsOrder[qIndex] || question.options.map((_, i) => i);
    const originalIndex = optOrder[idx] ?? idx;

    const selectedOption = question.options[originalIndex];
    const scores = selectedOption?.scores || {};

    attempt.answers.push({
      questionId: question._id,
      quotient: question.quotient,
      selectedIndex: originalIndex,
      scores
    });

    await attempt.save();

    // Check if all questions answered
    if (attempt.answers.length >= attempt.questionIds.length) {
      return res.json({ ok: true, redirect: `/8qt/submit/${attempt._id}` });
    }

    res.json({ ok: true, redirect: `/8qt/test/${attempt._id}` });
  } catch (err) {
    console.error("[8qt answer]", err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// STEP 5 - SUBMIT & SCORE
// GET /8qt/submit/:attemptId (triggered after last answer)
// ══════════════════════════════════════════════════════════════
router.get("/submit/:attemptId", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.attemptId);
    if (!attempt) return res.status(404).render("8qt/error", { message: "Attempt not found" });
    if (attempt.status === "finished") return res.redirect(`/8qt/results/${attempt._id}`);

    // Load active configs for scoring context
    const configs = await EightQTConfig.find({ active: true })
      .sort({ displayOrder: 1 }).lean();

    // Compute scores (uses this attempt's stored per-quotient max when present)
    const quotientScores = computeQuotientScores(attempt.answers, configs, attempt.quotientMax);

    // Match archetype
    const archetype = await matchArchetype(quotientScores);
    const { dominant, edge } = getDominantAndEdge(quotientScores);

    // Save results
    attempt.quotientScores = quotientScores;
    attempt.archetypeId = archetype?._id || null;
    attempt.archetypeName = archetype?.name || "The Emerging Thinker";
    attempt.dominantQuotient = dominant;
    attempt.developmentEdge = edge;
    attempt.status = "finished";
    attempt.finishedAt = new Date();
    await attempt.save();

    res.redirect(`/8qt/results/${attempt._id}`);
  } catch (err) {
    console.error("[8qt submit]", err);
    res.status(500).render("8qt/error", { message: "Error calculating results." });
  }
});

// ══════════════════════════════════════════════════════════════
// STEP 6 - RESULTS PAGE
// GET /8qt/results/:attemptId
// ══════════════════════════════════════════════════════════════
router.get("/results/:attemptId", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.attemptId)
      .populate("archetypeId")
      .lean();

    if (!attempt) return res.status(404).render("8qt/error", { message: "Results not found." });
    if (attempt.status !== "finished") return res.redirect(`/8qt/test/${attempt._id}`);

    const template = await EightQTCertTemplate.findOne({ active: true }).lean();
    const archetype = attempt.archetypeId;

    // Build dominant/edge config descriptions
    const configs = await EightQTConfig.find({ active: true }).lean();
    const configMap = {};
    for (const c of configs) configMap[c.code] = c;

    const dominantConfig = configMap[attempt.dominantQuotient] || null;
    const edgeConfig = configMap[attempt.developmentEdge] || null;

    // Share URL
    const shareUrl = `${process.env.SITE_URL || ""}/8qt/results/${attempt._id}`;
    const publicProfileUrl = attempt.profilePublic ? shareUrl : null;

    res.render("8qt/results", {
      attempt,
      archetype,
      quotientScores: attempt.quotientScores || [],
      dominantConfig,
      edgeConfig,
      template,
      shareUrl,
      publicProfileUrl,
      certStatus: attempt.certificateStatus,
      participantCode: attempt.participantCode,
      displayName: attempt.participantName,
      user: req.user || null
    });
  } catch (err) {
    console.error("[8qt results]", err);
    res.status(500).render("8qt/error", { message: "Error loading results." });
  }
});

// ══════════════════════════════════════════════════════════════
// STEP 7 - CERTIFICATE REQUEST FORM
// GET  /8qt/certificate/:attemptId
// POST /8qt/certificate/:attemptId
// ══════════════════════════════════════════════════════════════
router.get("/certificate/:attemptId", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.attemptId).lean();
    if (!attempt || attempt.status !== "finished") {
      return res.redirect(`/8qt/${attempt ? `results/${attempt._id}` : ""}`);
    }

    const template = await EightQTCertTemplate.findOne({ active: true }).lean();

    res.render("8qt/cert_request", {
      attempt,
      template,
      user: req.user || null,
      prices: {
        standard: template ? (template.standardPriceCents / 100).toFixed(2) : "9.99",
        premium: template ? (template.premiumPriceCents / 100).toFixed(2) : "24.99"
      },
      error: null
    });
  } catch (err) {
    res.status(500).render("8qt/error", { message: "Error loading certificate page." });
  }
});

router.post("/certificate/:attemptId", async (req, res) => {
  try {
    const { fullName, email, orgName, tier, makePublic } = req.body;
    if (!fullName || !email) {
      return res.status(400).json({ error: "Full name and email are required." });
    }

    const attempt = await EightQTAttempt.findById(req.params.attemptId);
    if (!attempt || attempt.status !== "finished") {
      return res.status(400).json({ error: "Invalid attempt" });
    }

    // Already issued?
    if (attempt.certificateStatus === "issued") {
      return res.json({ ok: true, redirect: `/8qt/results/${attempt._id}` });
    }

    // Update request details
    attempt.certificateName = fullName.trim();
    attempt.certificateEmail = email.trim().toLowerCase();
    attempt.certificateOrg = orgName?.trim() || "";
    attempt.profilePublic = makePublic === "true" || makePublic === "on";
    attempt.certificateStatus = "requested";
    attempt.certificateRequestedAt = new Date();
    await attempt.save();

    // Optional: convert anonymous to registered
    if (!attempt.userId && req.body.password && email) {
      try {
        const existing = await User.findOne({ email: email.toLowerCase() }).lean();
        if (!existing) {
          const newUser = new User({
            email: email.toLowerCase(),
            firstName: fullName.split(" ")[0],
            lastName: fullName.split(" ").slice(1).join(" "),
            role: "parent",
            consumerEnabled: true,
            needsPasswordSetup: false
          });
          await newUser.setPassword(req.body.password);
          newUser.username = await User.createUniqueUsername(
            newUser.firstName, newUser.lastName
          );
          await newUser.save();
          // Link attempt to new user
          attempt.userId = newUser._id;
          await attempt.save();
          console.log(`[8qt] Converted anonymous to registered: ${email}`);
        }
      } catch (e) {
        console.warn("[8qt] user conversion failed:", e.message);
      }
    }

    // Proceed to Stripe
    res.json({ ok: true, redirect: `/8qt/checkout/${attempt._id}?tier=${tier || "standard"}` });
  } catch (err) {
    console.error("[8qt cert request]", err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// STEP 8 - STRIPE CHECKOUT
// GET /8qt/checkout/:attemptId
// ══════════════════════════════════════════════════════════════
router.get("/checkout/:attemptId", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.attemptId).lean();
    if (!attempt || attempt.certificateStatus === "none") {
      return res.redirect(`/8qt/results/${req.params.attemptId}`);
    }
    if (attempt.certificateStatus === "issued") {
      return res.redirect(`/8qt/results/${attempt._id}`);
    }

    const template = await EightQTCertTemplate.findOne({ active: true }).lean();
    const tier = req.query.tier === "premium" ? "premium" : "standard";
    const priceCents = tier === "premium"
      ? (template?.premiumPriceCents || 2499)
      : (template?.standardPriceCents || 999);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: template?.currency || "usd",
          product_data: {
            name: `CRIPFCnt 8 Quotients Certificate (${tier === "premium" ? "Premium" : "Standard"})`,
            description: `Official ${attempt.archetypeName || ""} profile certificate with verification code`
          },
          unit_amount: priceCents
        },
        quantity: 1
      }],
      mode: "payment",
      success_url: `${process.env.SITE_URL}/8qt/cert-success/${attempt._id}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/8qt/certificate/${attempt._id}`,
      customer_email: attempt.certificateEmail || undefined,
      metadata: {
        type: "8qt_certificate",
        attemptId: String(attempt._id),
        participantCode: attempt.participantCode || "",
        userId: attempt.userId ? String(attempt.userId) : "",
        tier,
        participantName: attempt.certificateName || "",
        archetypeName: attempt.archetypeName || ""
      }
    });

    res.redirect(session.url);
  } catch (err) {
    console.error("[8qt checkout]", err);
    res.status(500).render("8qt/error", { message: "Payment setup failed. Please try again." });
  }
});

// Success landing (Stripe redirects here after payment)
// Actual processing happens in webhook - this is just a waiting/confirmation page
router.get("/cert-success/:attemptId", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.attemptId).lean();
    if (!attempt) return res.redirect("/8qt");

    // If certificate already issued (webhook was very fast), redirect straight to PDF download
    if (attempt.certificateStatus === "issued" && attempt.certificatePdfUrl) {
      const siteUrl = process.env.SITE_URL || "";
      const pdfUrl = attempt.certificatePdfUrl.startsWith("http")
        ? attempt.certificatePdfUrl
        : siteUrl + attempt.certificatePdfUrl;
      return res.redirect(pdfUrl);
    }

    res.render("8qt/cert_success", {
      attempt,
      message: "Payment received. Your certificate is being prepared and will be emailed to you shortly.",
      pdfUrl: attempt.certificatePdfUrl || null
    });
  } catch (err) {
    res.status(500).render("8qt/error", { message: "Error loading confirmation." });
  }
});

// ══════════════════════════════════════════════════════════════
// STEP 9 - PUBLIC VERIFICATION
// GET /8qt/verify/:verifyCode
// ══════════════════════════════════════════════════════════════
router.get("/verify/:verifyCode", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findOne({
      certificateVerifyCode: req.params.verifyCode.toUpperCase()
    }).lean();

    if (!attempt || attempt.certificateStatus !== "issued") {
      return res.render("8qt/verify", {
        valid: false,
        message: "Certificate not found or not yet issued."
      });
    }

    res.render("8qt/verify", {
      valid: true,
      participantName: attempt.certificateName || attempt.participantName,
      archetypeName: attempt.archetypeName,
      issuedAt: attempt.certificateIssuedAt,
      dominantQuotient: attempt.dominantQuotient,
      // Only show scores if participant made profile public
      scores: attempt.profilePublic ? attempt.quotientScores : null,
      verifyCode: req.params.verifyCode.toUpperCase()
    });
  } catch (err) {
    console.error("[8qt verify]", err);
    res.status(500).render("8qt/error", { message: "Verification lookup failed." });
  }
});

// ══════════════════════════════════════════════════════════════
// API: Get current question data (for AJAX navigation)
// GET /8qt/api/attempt/:attemptId/status
// ══════════════════════════════════════════════════════════════
router.get("/api/attempt/:attemptId/status", async (req, res) => {
  try {
    const attempt = await EightQTAttempt.findById(req.params.attemptId)
      .select("status answers questionIds participantCode certificateStatus certificatePdfUrl")
      .lean();
    if (!attempt) return res.status(404).json({ error: "Not found" });
    const siteUrl = process.env.SITE_URL || "";
    const rawPdf = attempt.certificatePdfUrl || null;
    const pdfUrl = rawPdf
      ? (rawPdf.startsWith("http") ? rawPdf : siteUrl + rawPdf)
      : null;
    res.json({
      status: attempt.status,
      answeredCount: attempt.answers.length,
      totalQuestions: attempt.questionIds.length,
      progress: Math.round((attempt.answers.length / attempt.questionIds.length) * 100),
      certificateStatus: attempt.certificateStatus,
      pdfUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
// STRIPE WEBHOOK - POST /8qt/webhook
// Handles checkout.session.completed for type=8qt_certificate.
// This is the ONLY place that generates and issues the cert PDF
// after a successful Stripe payment. The cert-success page is
// just a holding page that polls for the PDF URL.
//
// IMPORTANT: this route needs raw body parsing.
// In your Express app, BEFORE bodyParser.json(), add:
//   app.use("/8qt/webhook", express.raw({ type: "application/json" }));
// OR register this route before any json() middleware.
// ══════════════════════════════════════════════════════════════
router.post("/webhook", async (req, res) => {
  const sig     = req.headers["stripe-signature"];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET_8QT || process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    // req.body must be the raw buffer - ensure raw body middleware is registered
    // for this path before Express json() parser
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("[8qt webhook] signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== "checkout.session.completed") {
    return res.json({ received: true });
  }

  const session = event.data.object;

  // Only handle 8qt certificate purchases
  if (session.metadata?.type !== "8qt_certificate") {
    return res.json({ received: true });
  }

  const attemptId = session.metadata?.attemptId;
  if (!attemptId) {
    console.error("[8qt webhook] No attemptId in metadata");
    return res.json({ received: true });
  }

  // Idempotency: if cert already issued, skip
  try {
    const existing = await EightQTAttempt.findById(attemptId).lean();
    if (!existing) {
      console.error("[8qt webhook] Attempt not found:", attemptId);
      return res.json({ received: true });
    }
    if (existing.certificateStatus === "issued") {
      console.log("[8qt webhook] Already issued, skipping:", attemptId);
      return res.json({ received: true });
    }

    // Record the purchase
    await EightQTCertPurchase.findOneAndUpdate(
      { stripeSessionId: session.id },
      {
        $set: {
          attemptId:   existing._id,
          userId:      existing.userId || null,
          participantCode: existing.participantCode || null,
          stripeSessionId: session.id,
          amountPaid:  session.amount_total || 0,
          currency:    session.currency || "usd",
          tier:        session.metadata?.tier || "standard",
          status:      "complete",
          paidAt:      new Date()
        }
      },
      { upsert: true, new: true }
    );

    // Mark attempt as paid before generating PDF
    await EightQTAttempt.findByIdAndUpdate(attemptId, {
      $set: { certificateStatus: "paid" }
    });

    // Load template + archetype
    const template  = await EightQTCertTemplate.findOne({ active: true }).lean();
    let archetype   = null;
    if (existing.archetypeId) {
      archetype = await EightQTArchetype.findById(existing.archetypeId).lean();
    }

    // Merge cert details from Stripe metadata into attempt object for the builder
    const attemptForPdf = {
      ...existing,
      certificateName:  session.metadata?.participantName || existing.certificateName || existing.participantName || "Participant",
      certificateEmail: session.customer_email || existing.certificateEmail || "",
      certificateOrg:   existing.certificateOrg || ""
    };

    // Generate PDF using the correct 8QT cert builder
    const { generateEightQTCertPdf } = await import("../services/eightQTCertPdf.js");
    const { url, verifyCode } = await generateEightQTCertPdf({
      attempt:   attemptForPdf,
      template,
      archetype
    });

    // Save final state
    await EightQTAttempt.findByIdAndUpdate(attemptId, {
      $set: {
        certificatePdfUrl:     url,
        certificateVerifyCode: verifyCode,
        certificateStatus:     "issued",
        certificateIssuedAt:   new Date(),
        certificateName:       attemptForPdf.certificateName,
        certificateEmail:      attemptForPdf.certificateEmail
      }
    });

    console.log(`[8qt webhook] Certificate issued for attempt ${attemptId}: ${url}`);
  } catch (err) {
    console.error("[8qt webhook] cert generation failed:", err.message, err.stack);
    // Return 200 to Stripe so it doesn't retry - cert generation errors are logged
    // and can be retried manually via admin panel
  }

  res.json({ received: true });
});

export default router;