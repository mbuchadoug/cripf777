// routes/mobileProfessional.js  ·  v2
//
// The PROFESSIONALS platform for the mobile app - now with NAMED, SELECTABLE
// assessments per course, free/locked tiers, search, attempts history, a
// knowledge map, and REAL PDF certificates issued on the device right after a
// pass.
//
// The account is the SAME User document used on cripfcnt.com; every attempt is
// written with source "mobile-app" + meta.track "professional" + the same
// userId, so everything shows up under the web account automatically.
//
// PURELY ADDITIVE and backward compatible:
//   • GET /quiz still accepts ?module=<pillar> (treated as that pillar's free
//     tier), so an older app build keeps working.
//   • POST /certificate-request still works (now it also issues the PDF).
//
// Mount in server.js AFTER the school router:
//    import mobileProfessionalRouter from "./routes/mobileProfessional.js";
//    app.use("/api/mobile/pro", mobileProfessionalRouter);

import express, { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";

import { requireMobileAuth } from "./mobileApi.js";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";

const router = Router();

// Parse JSON bodies at the ROUTER level. This makes POST endpoints work no
// matter where the router is mounted in server.js - even if it was mounted
// before the app-wide express.json(). If a global parser already ran, this is
// a harmless no-op (express.json skips when the body is already parsed). This
// is what was breaking submit: the POST body never reached req.body, so the
// server saw no examId / no answers.
router.use(express.json({ limit: "2mb" }));

const PASS_THRESHOLD = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);
const QUIZ_SIZE = parseInt(process.env.PRO_QUIZ_COUNT || "10", 10);
const TIER_MIN = 5; // a course needs at least this many answerable questions

/* ══════════════════════════════════════════════════════════════════
   THE EIGHT COURSES (framework pillars)
   ════════════════════════════════════════════════════════════════════ */
const PILLARS = [
  { module: "consciousness", code: "CsQ", name: "Consciousness", blurb: "Knowing what is actually happening - not just what you are told." },
  { module: "responsibility", code: "RQ", name: "Responsibility", blurb: "Owning outcomes, not just intentions." },
  { module: "interpretation", code: "IQ", name: "Interpretation", blurb: "Reading what others miss in the same information." },
  { module: "purpose", code: "PQ", name: "Purpose", blurb: "Direction that turns activity into contribution." },
  { module: "frequencies", code: "FQ", name: "Frequencies", blurb: "How you communicate decides who actually hears you." },
  { module: "civilization", code: "CvQ", name: "Civilization", blurb: "Connecting individual progress to collective advance." },
  { module: "negotiation", code: "NQ", name: "Negotiation", blurb: "Every outcome is negotiated, including the silences." },
  { module: "technology", code: "TQ", name: "Technology", blurb: "Understanding the new rules of who gets seen and trusted." }
];
const PILLAR_BY_MODULE = PILLARS.reduce((a, p) => ((a[p.module] = p), a), {});

/* ══════════════════════════════════════════════════════════════════
   NAMED ASSESSMENTS (tiers)
   Each course exposes up to five named assessments. The first is FREE for every
   professional (trial or paid). The rest unlock when the account is upgraded
   (paid, or activated by an admin). Each tier draws a distinct, deterministic
   slice of the course's question pool, so tiers are stable and don't overlap
   until the pool is exhausted.
   ════════════════════════════════════════════════════════════════════ */
const TIERS = [
  { key: "foundations", label: "Foundations", free: true,  blurb: "Core principles of the pillar." },
  { key: "applied",     label: "Applied",     free: false, blurb: "Putting the pillar to work in real decisions." },
  { key: "advanced",    label: "Advanced",    free: false, blurb: "Harder judgment calls and edge cases." },
  { key: "strategic",   label: "Strategic",   free: false, blurb: "Pillar thinking at team and system scale." },
  { key: "mastery",     label: "Mastery",     free: false, blurb: "The full-range capstone assessment." }
];
const TIER_BY_KEY = TIERS.reduce((a, t) => ((a[t.key] = t), a), {});

/** How many tiers a pool of this size can meaningfully support. */
function tiersForPool(poolSize) {
  if (poolSize < TIER_MIN) return [];
  const maxByPool = Math.max(1, Math.min(TIERS.length, Math.floor(poolSize / QUIZ_SIZE) || 1));
  return TIERS.slice(0, maxByPool);
}

/* ── deterministic RNG so a tier's question set is stable across calls ── */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function seededOrder(n, seedStr) {
  const rng = mulberry32(hashStr(seedStr));
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/** Turn a Question doc into safe app JSON - correctIndex is NEVER sent. */
function publicQuestion(q) {
  return {
    _id: String(q._id),
    text: q.text,
    choices: (q.choices || []).map((c) => ({ label: c.label, text: c.text })),
    module: q.module || null,
    type: q.type || "question",
    passage: q.passage || null
  };
}

async function resolveHomeOrg() {
  try { return await Organization.findOne({ slug: "cripfcnt-home" }).lean(); }
  catch { return null; }
}

// ── Professional LMS mirrors the WEB dashboard: an assessment is a comprehension
//    Question in the cripfcnt-school org, grouped by `category` (Professional
//    Area) and `series`. Each comprehension's questionIds are its child MCQ
//    questions. Same collection as the web => counts match exactly. ──
let _schoolOrgCache = null;
async function resolveSchoolOrg() {
  if (_schoolOrgCache) return _schoolOrgCache;
  try { _schoolOrgCache = await Organization.findOne({ slug: "cripfcnt-school" }).lean(); }
  catch { _schoolOrgCache = null; }
  return _schoolOrgCache;
}

function slugToLabel(slug) {
  const s = String(slug || "").split(/[-_]/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return s || "General";
}
function shortCode(label) {
  const words = String(label || "").split(/\s+/).filter(Boolean);
  if (!words.length) return "PA";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const FREE_PER_COURSE = parseInt(process.env.PRO_FREE_PER_COURSE || "1", 10);

// Category values that are not real Professional Areas (uncategorised junk).
const JUNK_CATEGORY = /^(undefined|null|none|general|out-of-scope|uncategori[sz]ed|n\/a)$/i;
function isJunkCategory(cat) {
  const s = String(cat == null ? "" : cat).trim();
  return !s || JUNK_CATEGORY.test(s);
}

async function loadProfessionalAssessments(orgId) {
  if (!orgId) return [];
  const docs = await Question.find({
    organization: orgId,
    type: "comprehension",
    "meta.isOutOfScope": { $ne: true },
    category: { $exists: true, $nin: [null, "", "out-of-scope", "undefined", "null", "none", "general"] }
  })
    .select("_id text quizTitle module modules series category level seriesOrder questionIds")
    .sort({ category: 1, series: 1, seriesOrder: 1, createdAt: -1 })
    .lean();
  // Belt & braces: also drop any junk-category values the query missed.
  return docs.filter((d) => !isJunkCategory(d.category));
}

function buildCategoryCourses(assessments, byQuiz, paid) {
  const groups = {};
  for (const a of assessments) {
    const cat = a.category;
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(a);
  }
  const courses = [];
  for (const [cat, list] of Object.entries(groups)) {
    const label = slugToLabel(cat);
    const code = shortCode(label);
    let totalQuestions = 0;
    const quizzes = list.map((a, i) => {
      const qc = Array.isArray(a.questionIds) ? a.questionIds.length : 0;
      totalQuestions += qc;
      const quizId = String(a._id);
      const stat = byQuiz[quizId] || null;
      const free = i < FREE_PER_COURSE;
      const locked = !free && !paid;
      const seriesLabel = a.series ? slugToLabel(a.series) : null;
      const levelLabel = a.level ? slugToLabel(a.level) : null;
      return {
        quizId,
        module: a.module || "general",
        code,
        courseName: label,
        category: cat,
        series: a.series || null,
        seriesLabel,
        level: a.level || "foundation",
        label: a.quizTitle || a.text || "Assessment",
        title: a.quizTitle || a.text || "Assessment",
        blurb: seriesLabel ? (levelLabel ? `${seriesLabel} \u00b7 ${levelLabel}` : seriesLabel) : (levelLabel || "Assessment"),
        questionCount: qc,
        free,
        locked,
        bestScore: stat?.bestScore ?? null,
        passed: !!stat?.passed,
        attempts: stat?.attempts || 0,
        status: stat?.passed ? "passed" : stat ? "attempted" : "new"
      };
    });
    courses.push({
      module: cat,
      code,
      name: label,
      blurb: `${list.length} assessment${list.length === 1 ? "" : "s"} in the ${label} area.`,
      category: cat,
      questionsAvailable: totalQuestions,
      available: list.length > 0,
      quizzes,
      quizCount: quizzes.length,
      freeCount: quizzes.filter((q) => q.free).length,
      lockedCount: quizzes.filter((q) => q.locked).length,
      bestScore: null,
      passed: quizzes.some((q) => q.passed),
      attempts: quizzes.reduce((s, q) => s + (q.attempts || 0), 0)
    });
  }
  courses.sort((a, b) => b.quizCount - a.quizCount);
  return courses;
}

/** Whether this professional is unlocked (paid, or admin-activated).
 *  Trial accounts (employeeSubscriptionStatus "trial", plan "none") are NOT. */
function isPaidPro(u) {
  if (!u) return false;
  if (u.employeeSubscriptionStatus === "paid") return true;
  if (u.employeeFullAccess === true) return true;
  const plan = u.employeeSubscriptionPlan;
  if (plan && plan !== "none") return true;
  return false;
}

async function findModuleQuestions(module) {
  return Question.find({
    $and: [
      { $or: [{ module }, { modules: module }] },
      { type: { $ne: "comprehension" } },
      { correctIndex: { $ne: null } },
      { "choices.1": { $exists: true } }
    ]
  })
    .select("text choices module type passage")
    .lean();
}
async function countModuleQuestions(module) {
  return Question.countDocuments({
    $and: [
      { $or: [{ module }, { modules: module }] },
      { type: { $ne: "comprehension" } },
      { correctIndex: { $ne: null } },
      { "choices.1": { $exists: true } }
    ]
  });
}

/** Read a professional's finished attempts, aggregated per-quiz and per-module. */
async function loadStandings(userId) {
  const finished = await ExamInstance.find({
    userId,
    "meta.track": "professional",
    status: "finished"
  })
    .select("module meta updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

  const byQuiz = {};
  const byModule = {};
  const bump = (bag, key, pct, passed) => {
    if (!key) return;
    if (!bag[key]) bag[key] = { bestScore: null, passed: false, attempts: 0, lastAt: null };
    bag[key].attempts += 1;
    if (pct != null && (bag[key].bestScore == null || pct > bag[key].bestScore)) bag[key].bestScore = pct;
    if (passed) bag[key].passed = true;
  };
  for (const e of finished) {
    const pct = typeof e.meta?.percentage === "number" ? e.meta.percentage : null;
    const passed = !!e.meta?.passed;
    const quizId = e.meta?.quizId || (e.module ? `${e.module}:foundations` : null);
    bump(byQuiz, quizId, pct, passed);
    bump(byModule, e.module, pct, passed);
  }
  return { finished, byQuiz, byModule };
}

/** Build the full course + named-quiz catalogue for a professional. */
function buildCourses({ counts, byQuiz, byModule, paid }) {
  const courses = [];
  for (const p of PILLARS) {
    const available = counts[p.module] || 0;
    const tiers = tiersForPool(available);
    const quizzes = tiers.map((t) => {
      const quizId = `${p.module}:${t.key}`;
      const stat = byQuiz[quizId] || null;
      const locked = !t.free && !paid;
      return {
        quizId,
        module: p.module,
        code: p.code,
        courseName: p.name,
        tier: t.key,
        label: t.label,
        title: `${p.name} · ${t.label}`,
        blurb: t.blurb,
        questionCount: Math.min(QUIZ_SIZE, available),
        free: t.free,
        locked,
        bestScore: stat?.bestScore ?? null,
        passed: !!stat?.passed,
        attempts: stat?.attempts || 0,
        status: stat?.passed ? "passed" : stat ? "attempted" : "new"
      };
    });
    const m = byModule[p.module] || {};
    courses.push({
      module: p.module,
      code: p.code,
      name: p.name,
      blurb: p.blurb,
      questionsAvailable: available,
      available: available >= TIER_MIN,
      quizzes,
      quizCount: quizzes.length,
      freeCount: quizzes.filter((q) => q.free).length,
      lockedCount: quizzes.filter((q) => q.locked).length,
      bestScore: m.bestScore ?? null,
      passed: !!m.passed,
      attempts: m.attempts || 0
    });
  }
  return courses;
}

/* ══════════════════════════════════════════════════════════════════
   CATALOG
   ════════════════════════════════════════════════════════════════════ */
router.get("/catalog", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const paid = isPaidPro(me);
    const { byQuiz } = await loadStandings(me._id);
    const org = await resolveSchoolOrg();
    const assessments = await loadProfessionalAssessments(org?._id);
    const courses = buildCategoryCourses(assessments, byQuiz, paid);
    return res.json({
      courses,
      isPaid: paid,
      plan: me.employeeSubscriptionPlan || "none",
      subscriptionStatus: me.employeeSubscriptionStatus || "trial",
      passThreshold: PASS_THRESHOLD,
      freePerCourse: FREE_PER_COURSE,
      totalAssessments: assessments.length,
      // Upgrade routing. iOS never shows an in-app purchase/link (App Store
      // rule 3.1.1). Android can open the existing web checkout (Stripe/EcoCash)
      // and is remote-controllable via PRO_ANDROID_UPGRADE so you can switch it
      // off without an app update if Google Play ever objects.
      upgrade: {
        url: process.env.PRO_UPGRADE_URL || "https://cripfcnt.com/upgrade",
        android: String(process.env.PRO_ANDROID_UPGRADE ?? "true").toLowerCase() === "true",
        ios: false
      },
      user: {
        displayName: me.displayName || [me.firstName, me.lastName].filter(Boolean).join(" "),
        email: me.email || null
      }
    });
  } catch (err) {
    console.error("[mobile pro/catalog]", err);
    return res.status(500).json({ error: "Could not load courses." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   SEARCH  ·  GET /search?q=...
   Matches across course name, code, tier label and blurb.
   ════════════════════════════════════════════════════════════════════ */
router.get("/search", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const q = String(req.query.q || "").trim().toLowerCase();
    const paid = isPaidPro(me);
    const { byQuiz } = await loadStandings(me._id);
    const org = await resolveSchoolOrg();
    const assessments = await loadProfessionalAssessments(org?._id);
    const courses = buildCategoryCourses(assessments, byQuiz, paid);
    const all = [];
    for (const c of courses) for (const qz of c.quizzes) all.push(qz);
    const results = !q ? all : all.filter((qz) => {
      const hay = `${qz.courseName} ${qz.code} ${qz.label} ${qz.title} ${qz.seriesLabel || ""} ${qz.category}`.toLowerCase();
      return hay.includes(q);
    });
    return res.json({ query: q, count: results.length, results });
  } catch (err) {
    console.error("[mobile pro/search]", err);
    return res.status(500).json({ error: "Search failed." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   LOAD AN ASSESSMENT  ·  GET /quiz?quizId=<module:tier>   (or ?module=<pillar>)
   ════════════════════════════════════════════════════════════════════ */
router.get("/quiz", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const quizId = String(req.query.quizId || "").trim();
    if (!quizId || !mongoose.isValidObjectId(quizId)) {
      return res.status(400).json({ error: "Unknown assessment." });
    }
    const org = await resolveSchoolOrg();
    const parent = await Question.findOne({
      _id: quizId,
      type: "comprehension",
      ...(org?._id ? { organization: org._id } : {})
    }).lean();
    if (!parent) {
      return res.status(404).json({ code: "NO_ASSESSMENT", error: "This assessment is no longer available." });
    }

    let free = true;
    if (org?._id && parent.category) {
      const peers = await Question.find({
        organization: org._id, type: "comprehension",
        category: parent.category, "meta.isOutOfScope": { $ne: true }
      }).select("_id").sort({ series: 1, seriesOrder: 1, createdAt: -1 }).lean();
      const idx = peers.findIndex((x) => String(x._id) === String(parent._id));
      free = idx > -1 && idx < FREE_PER_COURSE;
    }
    if (!free && !isPaidPro(me)) {
      return res.status(402).json({ code: "UPGRADE_REQUIRED", error: "This assessment unlocks when your account is upgraded." });
    }

    const childIds = (parent.questionIds || []).filter((id) => mongoose.isValidObjectId(id));
    const childDocs = childIds.length
      ? await Question.find({ _id: { $in: childIds }, correctIndex: { $ne: null }, "choices.1": { $exists: true } })
          .select("text choices module type passage").lean()
      : [];
    const byId = {};
    for (const d of childDocs) byId[String(d._id)] = d;
    const ordered = childIds.map((id) => byId[String(id)]).filter(Boolean);
    if (ordered.length < 1) {
      return res.status(422).json({ code: "NO_ASSESSMENT", error: "This assessment has no questions yet." });
    }

    const passage = parent.passage || parent.text || null;
    const questions = ordered.map((q) => {
      const pub = publicQuestion(q);
      if (!pub.passage && passage) pub.passage = passage;
      return pub;
    });
    const resolvedIds = questions.map((x) => x._id);
    const module = parent.module || "general";
    const category = parent.category || null;
    const title = parent.quizTitle || parent.text || "Assessment";
    const pillar = PILLAR_BY_MODULE[module] || null;

    const exam = await ExamInstance.create({
      examId: crypto.randomUUID(),
      org: org?._id || me.organization || null,
      userId: me._id,
      targetRole: "employee",
      module,
      quizTitle: title,
      title,
      status: "started",
      durationMinutes: 0,
      questionIds: resolvedIds,
      meta: {
        track: "professional",
        subject: module,
        code: pillar?.code || null,
        quizId: String(parent._id),
        category,
        series: parent.series || null,
        quizLabel: title,
        source: "mobile-app"
      }
    });

    return res.json({
      examId: exam.examId,
      quizId: String(parent._id),
      module,
      category,
      code: pillar?.code || null,
      title,
      questionCount: questions.length,
      passage,
      questions
    });
  } catch (err) {
    console.error("[mobile pro/quiz]", err);
    return res.status(500).json({ error: "Could not load the assessment." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   SUBMIT  ·  POST /quiz/submit  { examId, answers:[{questionId,choiceIndex}] }
   ════════════════════════════════════════════════════════════════════ */
router.post("/quiz/submit", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    let examId = String(req.body?.examId || "").trim();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const bodyModule = String(req.body?.module || "").trim().toLowerCase();
    const bodyQuizId = String(req.body?.quizId || "").trim().toLowerCase();

    if (!answers.length) return res.status(400).json({ error: "No answers submitted." });

    // examId is OPTIONAL. Scoring only needs the answers + the question bank, so
    // even if the client could not carry an examId (load session lost, older
    // build, mid-deploy), we mint one and synthesize the record below. This
    // makes a completed assessment impossible to lose.
    if (!examId) examId = crypto.randomUUID();

    // Resilience: normally the ExamInstance was created when the quiz loaded.
    // If it is somehow missing (session expired / cleaned up / edge case) we do
    // NOT fail a completed attempt. We synthesize a finished record from the
    // payload so the professional is still marked, recorded, and certified on a
    // pass. This makes the submit impossible to lose.
    let exam = await ExamInstance.findOne({ examId, userId: me._id });
    if (!exam) {
      const pillarFb = PILLAR_BY_MODULE[bodyModule] || null;
      const orgFb = await resolveHomeOrg();
      // Derive a tier label from quizId ("module:tier") when the client sent it.
      const tierKeyFb = bodyQuizId.includes(":") ? bodyQuizId.split(":")[1] : null;
      const tierFb = (tierKeyFb && TIER_BY_KEY[tierKeyFb]) || null;
      const labelFb = pillarFb
        ? `${pillarFb.name} · ${tierFb ? tierFb.label : "Assessment"}`
        : "Professional Assessment";
      exam = new ExamInstance({
        examId,
        org: orgFb?._id || me.organization || null,
        userId: me._id,
        targetRole: "employee",
        module: bodyModule || null,
        quizTitle: labelFb,
        title: labelFb,
        status: "started",
        durationMinutes: 0,
        questionIds: [],
        meta: {
          track: "professional",
          subject: bodyModule || null,
          code: pillarFb?.code || null,
          quizId: bodyQuizId || (bodyModule ? `${bodyModule}:foundations` : null),
          tier: tierFb ? tierFb.key : (bodyQuizId.includes(":") ? bodyQuizId.split(":")[1] : "foundations"),
          quizLabel: labelFb,
          source: "mobile-app"
        }
      });
    }

    const module = exam.module || String(req.body?.module || "").trim().toLowerCase();
    const pillar = PILLAR_BY_MODULE[module] || null;

    const qIds = answers.map((a) => String(a.questionId)).filter(Boolean);
    const docs = await Question.find({ _id: { $in: qIds } }).select("correctIndex module modules choices text").lean();
    const byId = {};
    for (const d of docs) byId[String(d._id)] = d;

    let correct = 0;
    const saved = [];
    const attemptAnswers = [];
    // 8QT scoring: tally correctness per quotient using each question's module
    // tags. Professional assessments are broad and span several quotients, so
    // the certificate shows the full eight-dimension profile of THIS attempt.
    const qTally = {};
    for (const a of answers) {
      const qid = String(a.questionId);
      const qd = byId[qid] || {};
      const ci = qd.correctIndex;
      const isCorrect = typeof ci === "number" && ci === a.choiceIndex;
      if (isCorrect) correct++;
      const selectedText =
        Array.isArray(qd.choices) && qd.choices[a.choiceIndex] ? qd.choices[a.choiceIndex].text || "" : "";
      saved.push({ questionId: qid, choiceIndex: a.choiceIndex, correctIndex: ci, correct: isCorrect });
      {
        const qMods = Array.isArray(qd.modules) && qd.modules.length ? qd.modules : (qd.module ? [qd.module] : []);
        const codes = new Set();
        for (const m of qMods) { const c = PILLAR_BY_MODULE[String(m).toLowerCase()]?.code; if (c) codes.add(c); }
        for (const c of codes) { if (!qTally[c]) qTally[c] = { earned: 0, total: 0 }; qTally[c].total++; if (isCorrect) qTally[c].earned++; }
      }
      attemptAnswers.push({
        questionId: mongoose.isValidObjectId(qid) ? new mongoose.Types.ObjectId(qid) : qid,
        choiceIndex: a.choiceIndex,
        shownIndex: a.choiceIndex,
        selectedText,
        correctIndex: typeof ci === "number" ? ci : null,
        correct: isCorrect
      });
    }

    const total = answers.length;
    const percentage = Math.round((correct / Math.max(1, total)) * 100);
    const passed = percentage >= PASS_THRESHOLD;
    const now = new Date();

    // Build the eight-quotient profile from the tally (all 8 axes; untested = 0).
    const quotientScores = PILLARS.map((pp) => {
      const t = qTally[pp.code] || { earned: 0, total: 0 };
      const sc = t.total ? Math.round((t.earned / t.total) * 100) : 0;
      return { code: pp.code, name: pp.name, score: sc, tested: t.total > 0, band: band(sc) };
    });
    const testedScores = quotientScores.filter((x) => x.tested);
    const dominantQuotient = (testedScores.slice().sort((a, b) => b.score - a.score)[0]?.code) || pillar?.code || null;

    exam.status = "finished";
    exam.meta = {
      ...(exam.meta || {}),
      track: "professional",
      code: pillar?.code || exam.meta?.code || null,
      subject: module,
      score: correct,
      total,
      percentage,
      passed,
      certificateEligible: passed,
      answers: saved,
      quotientScores,
      dominantQuotient,
      finishedAt: now.toISOString(),
      source: "mobile-app"
    };
    exam.markModified("meta");
    await exam.save();

    try {
      let orgId = exam.org || me.organization || null;
      if (!orgId) { const home = await resolveHomeOrg(); orgId = home?._id || null; }
      const savedAttempt = await Attempt.findOneAndUpdate(
        { examId, userId: me._id },
        {
          $set: {
            examId, userId: me._id, organization: orgId, module, subject: module,
            quizTitle: exam.quizTitle || exam.title || "Assessment",
            questionIds: exam.questionIds || qIds,
            answers: attemptAnswers,
            score: correct, correctCount: correct, maxScore: total,
            scorePct: percentage, percentage, passed,
            status: "finished", source: "mobile-app", finishedAt: now
          },
          $setOnInsert: { startedAt: exam.startedAt || now }
        },
        { upsert: true, new: true }
      );
      if (savedAttempt && savedAttempt._id) {
        import("../services/topicMasteryTracker.js")
          .then((m) => m.updateTopicMasteryFromAttempt(savedAttempt._id))
          .catch(() => {});
      }
    } catch (attErr) {
      console.error("[mobile pro/submit] Attempt write failed:", attErr.message);
    }

    return res.json({
      examId,
      module,
      code: pillar?.code || null,
      quizId: exam.meta?.quizId || null,
      tier: exam.meta?.tier || null,
      title: exam.quizTitle || exam.title || "Assessment",
      score: correct,
      total,
      percentage,
      passed,
      passThreshold: PASS_THRESHOLD,
      certificateEligible: passed,
      answerKey: saved.map((s) => ({ questionId: s.questionId, correctIndex: s.correctIndex, correct: s.correct }))
    });
  } catch (err) {
    console.error("[mobile pro/quiz/submit]", err);
    return res.status(500).json({ error: "Could not submit the assessment." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   ISSUE A REAL PDF CERTIFICATE (shared by /certificate and legacy alias)
   ════════════════════════════════════════════════════════════════════ */
// 8QT band labels (matches services/eightQTScoring.js getBand thresholds).
function band8QT(score) {
  if (score == null) return "Emerging";
  if (score >= 81) return "Recalibrative";
  if (score >= 61) return "Structural";
  if (score >= 41) return "Functional";
  if (score >= 21) return "Developing";
  return "Emerging";
}

// Compute a professional's eight-quotient profile the 8QT way: aggregate every
// answered question across all their finished professional attempts, bucket each
// by the quotient(s) its module/modules map to, and score correct/total per
// quotient. Because the assessments are broad and span quotients, this yields a
// real radar rather than a single-pillar spike.
async function computeProfessionalQuotients(userId) {
  const attempts = await ExamInstance.find({
    userId, "meta.track": "professional", status: "finished"
  }).select("questionIds meta").lean();

  const perQ = {}; // questionId -> { correct, total }
  for (const a of attempts) {
    const answers = Array.isArray(a.meta?.answers) ? a.meta.answers : [];
    for (const ans of answers) {
      const qid = String(ans.questionId || "");
      if (!qid) continue;
      if (!perQ[qid]) perQ[qid] = { correct: 0, total: 0 };
      perQ[qid].total += 1;
      if (ans.correct) perQ[qid].correct += 1;
    }
  }

  const qids = Object.keys(perQ).filter((id) => mongoose.isValidObjectId(id));
  const qDocs = qids.length
    ? await Question.find({ _id: { $in: qids } }).select("module modules").lean()
    : [];
  const modsById = {};
  for (const q of qDocs) {
    const set = new Set();
    if (q.module) set.add(String(q.module).toLowerCase());
    for (const m of (q.modules || [])) set.add(String(m).toLowerCase());
    modsById[String(q._id)] = set;
  }

  const agg = {};
  for (const p of PILLARS) agg[p.module] = { correct: 0, total: 0 };
  for (const [qid, cnt] of Object.entries(perQ)) {
    const set = modsById[qid];
    if (!set) continue;
    for (const p of PILLARS) {
      if (set.has(p.module)) {
        agg[p.module].correct += cnt.correct;
        agg[p.module].total += cnt.total;
      }
    }
  }

  const quotientScores = PILLARS.map((p) => {
    const { correct, total } = agg[p.module];
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;
    return { code: p.code, name: p.name, score, band: band8QT(score) };
  });
  const hasData = quotientScores.some((q) => q.score > 0);
  return { quotientScores, hasData };
}

async function issueCertificate({ exam, me, req, name }) {
  // Already issued? Return the stored URL (idempotent).
  if (exam.meta?.certificateUrl) {
    return { certificateUrl: exam.meta.certificateUrl, certificateStatus: "issued", reused: true };
  }
  let orgName = "CRIPFCnt";
  try {
    if (exam.org) { const o = await Organization.findById(exam.org).lean(); if (o) orgName = o.name || o.title || orgName; }
  } catch {}

  const recipientName =
    name || me.displayName || [me.firstName, me.lastName].filter(Boolean).join(" ") || "Professional";

  // 8QT scoring model: the certificate shows the professional's eight-dimension
  // profile (radar + bands + dominant quotient), rendered by the real 8QT template.
  // Prefer THIS assessment's own quotient coverage (computed at submit from the
  // questions' module tags); fall back to the aggregate profile for older attempts.
  let scores;
  const perAttempt = Array.isArray(exam.meta?.quotientScores) ? exam.meta.quotientScores : null;
  if (perAttempt && perAttempt.some((q) => q.tested || q.score > 0)) {
    scores = PILLARS.map((p) => {
      const found = perAttempt.find((q) => q.code === p.code);
      const sc = found ? Math.max(0, Math.min(100, Math.round(found.score))) : 0;
      return { code: p.code, name: p.name, score: sc, band: band8QT(sc) };
    });
  } else {
    const { quotientScores, hasData } = await computeProfessionalQuotients(me._id);
    scores = quotientScores;
    if (!hasData) {
      const pillar = PILLAR_BY_MODULE[exam.module] || null;
      const pct = Math.round(Number(exam.meta?.percentage) || 0);
      scores = PILLARS.map((p) => {
        const s = pillar && p.module === pillar.module ? pct : 0;
        return { code: p.code, name: p.name, score: s, band: band8QT(s) };
      });
    }
  }
  const best = scores.slice().sort((a, b) => b.score - a.score)[0];
  const dominant = exam.meta?.dominantQuotient || (best && best.score > 0 ? best.code : (PILLAR_BY_MODULE[exam.module]?.code || null));

  const attempt = {
    certificateName: recipientName,
    certificateOrg: orgName,
    certificateIssuedAt: exam.meta?.finishedAt ? new Date(exam.meta.finishedAt) : new Date(),
    quotientScores: scores,
    dominantQuotient: dominant
  };
  const template = {
    certTitle: "Certificate of Achievement",
    assessmentName: "CRIPFCnt Professional Assessment",
    designation: "CRIPFCnt Professional"
  };

  const { generateEightQTCertPdf } = await import("../services/eightQTCertPdf.js");
  const certResult = await generateEightQTCertPdf({ attempt, template, archetype: null });
  if (!certResult?.url) throw new Error("Certificate file was not produced.");

  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const baseForMedia = site || `${req.protocol}://${req.get("host")}`;
  const rel = certResult.url.startsWith("/") ? certResult.url : `/${certResult.url}`;
  const certificateUrl = `${baseForMedia}${rel}`;

  exam.meta = {
    ...(exam.meta || {}),
    certificateStatus: "issued",
    certificateUrl,
    certificateVerifyCode: certResult.verifyCode || null,
    certificateName: recipientName,
    certificateIssuedAt: new Date().toISOString()
  };
  exam.markModified("meta");
  await exam.save();
  return { certificateUrl, certificateStatus: "issued", reused: false };
}

/* POST /certificate  { examId, name, email }  → generates + returns certificateUrl */
router.post("/certificate", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const examId = String(req.body?.examId || "").trim();
    if (!examId) return res.status(400).json({ error: "Missing examId." });

    const exam = await ExamInstance.findOne({ examId, userId: me._id });
    if (!exam) return res.status(404).json({ error: "Assessment not found. Sync it first." });
    if (!exam.meta?.passed) return res.status(400).json({ error: "You need to pass this assessment first." });

    const name = String(req.body?.name || me.displayName || "").trim() || undefined;
    const out = await issueCertificate({ exam, me, req, name });
    return res.json({ ok: true, examId, ...out });
  } catch (err) {
    console.error("[mobile pro/certificate]", err);
    return res.status(500).json({ error: "Could not generate the certificate. Please try again." });
  }
});

/* Legacy alias - older app builds call this. Now it issues the PDF too. */
router.post("/certificate-request", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const examId = String(req.body?.examId || "").trim();
    if (!examId) return res.status(400).json({ error: "Missing examId." });
    const exam = await ExamInstance.findOne({ examId, userId: me._id });
    if (!exam) return res.status(404).json({ error: "Assessment not found. Sync it first." });
    if (!exam.meta?.passed) return res.status(400).json({ error: "You need to pass this assessment first." });
    const name = String(req.body?.name || me.displayName || "").trim() || undefined;
    const out = await issueCertificate({ exam, me, req, name });
    return res.json({ ok: true, examId, ...out });
  } catch (err) {
    console.error("[mobile pro/certificate-request]", err);
    return res.status(500).json({ error: "Could not record the request." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   CERTIFICATES - best passing attempt per course, with the PDF URL if issued.
   ════════════════════════════════════════════════════════════════════ */
router.get("/certificates", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const passed = await ExamInstance.find({
      userId: me._id, "meta.track": "professional", status: "finished", "meta.passed": true
    })
      .select("examId module quizTitle title meta updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    const bestByModule = {};
    for (const e of passed) {
      const key = e.module;
      const pct = typeof e.meta?.percentage === "number" ? e.meta.percentage : 0;
      // Prefer an attempt that already has a PDF, else the highest score.
      const cur = bestByModule[key];
      const curPct = cur ? (cur.meta?.percentage || 0) : -1;
      const curHasUrl = cur ? !!cur.meta?.certificateUrl : false;
      const thisHasUrl = !!e.meta?.certificateUrl;
      if (!cur || (thisHasUrl && !curHasUrl) || (thisHasUrl === curHasUrl && pct > curPct)) {
        bestByModule[key] = e;
      }
    }

    const certificates = Object.values(bestByModule).map((e) => {
      const pillar = PILLAR_BY_MODULE[e.module] || {};
      return {
        examId: e.examId,
        module: e.module,
        code: pillar.code || null,
        name: pillar.name || e.module,
        title: e.meta?.quizLabel || e.quizTitle || e.title || `${pillar.name || e.module} · Assessment`,
        percentage: e.meta?.percentage ?? null,
        passedAt: e.meta?.finishedAt || e.updatedAt,
        certificateStatus: e.meta?.certificateUrl ? "issued" : (e.meta?.certificateStatus || "earned"),
        certificateUrl: e.meta?.certificateUrl || null
      };
    });

    return res.json({
      certificates,
      user: {
        displayName: me.displayName || [me.firstName, me.lastName].filter(Boolean).join(" "),
        email: me.email || null
      }
    });
  } catch (err) {
    console.error("[mobile pro/certificates]", err);
    return res.status(500).json({ error: "Could not load certificates." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   ATTEMPTS HISTORY  ·  GET /attempts
   ════════════════════════════════════════════════════════════════════ */
router.get("/attempts", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const rows = await ExamInstance.find({
      userId: me._id, "meta.track": "professional", status: "finished"
    })
      .select("examId module quizTitle title meta updatedAt")
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();

    const attempts = rows.map((e) => {
      const pillar = PILLAR_BY_MODULE[e.module] || {};
      return {
        examId: e.examId,
        module: e.module,
        code: pillar.code || null,
        courseName: pillar.name || e.module,
        title: e.meta?.quizLabel || e.quizTitle || e.title || "Assessment",
        tier: e.meta?.tier || null,
        percentage: e.meta?.percentage ?? null,
        score: e.meta?.score ?? null,
        total: e.meta?.total ?? null,
        passed: !!e.meta?.passed,
        certificateUrl: e.meta?.certificateUrl || null,
        finishedAt: e.meta?.finishedAt || e.updatedAt
      };
    });

    return res.json({ attempts, passThreshold: PASS_THRESHOLD });
  } catch (err) {
    console.error("[mobile pro/attempts]", err);
    return res.status(500).json({ error: "Could not load attempts." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   KNOWLEDGE MAP  ·  GET /knowledge-map
   Per-pillar best score + band, ready for the radar chart.
   ════════════════════════════════════════════════════════════════════ */
function band(pct) {
  if (pct == null) return "Not started";
  if (pct >= 80) return "Strong";
  if (pct >= 60) return "Proficient";
  if (pct >= 40) return "Developing";
  return "Emerging";
}
router.get("/knowledge-map", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const { byModule } = await loadStandings(me._id);

    const pillars = PILLARS.map((p) => {
      const m = byModule[p.module] || {};
      const score = m.bestScore ?? null;
      return {
        module: p.module,
        code: p.code,
        name: p.name,
        score: score == null ? 0 : score,
        hasData: score != null,
        attempts: m.attempts || 0,
        passed: !!m.passed,
        band: band(score)
      };
    });

    const withData = pillars.filter((p) => p.hasData);
    const overall = withData.length
      ? Math.round(withData.reduce((s, p) => s + p.score, 0) / withData.length)
      : null;
    const strongest = withData.slice().sort((a, b) => b.score - a.score)[0] || null;
    const weakest = withData.slice().sort((a, b) => a.score - b.score)[0] || null;

    return res.json({
      pillars,
      overall,
      coverage: withData.length,
      totalPillars: PILLARS.length,
      passedCount: pillars.filter((p) => p.passed).length,
      strongest: strongest ? { code: strongest.code, name: strongest.name, score: strongest.score } : null,
      focus: weakest ? { code: weakest.code, name: weakest.name, score: weakest.score } : null
    });
  } catch (err) {
    console.error("[mobile pro/knowledge-map]", err);
    return res.status(500).json({ error: "Could not load your knowledge map." });
  }
});

export default router;