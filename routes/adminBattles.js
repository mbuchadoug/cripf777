// routes/adminBattles.js
import { Router } from "express";
import Battle from "../models/battle.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// role guard
function ensureBattleAdmin(req, res, next) {
  if (!req.user) return res.status(401).send("Not logged in");
  if (!["private_teacher", "employee"].includes(req.user.role)) {
    return res.status(403).send("Not allowed");
  }
  next();
}

function toInt(v, def) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeCategory(v) {
  return String(v || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeSubject(v) {
  return String(v || "").trim().toLowerCase();
}

function parseDate(v) {
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * GET /admin/battles
 * List battles (latest first)
 */
router.get("/admin/battles", ensureAuth, ensureBattleAdmin, async (req, res) => {
  const battles = await Battle.find({})
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  res.render("admin/battles/index", {
    user: req.user,
    battles
  });
});

/**
 * GET /admin/battles/new
 * Create form
 */
router.get("/admin/battles/new", ensureAuth, ensureBattleAdmin, async (req, res) => {
  res.render("admin/battles/new", {
    user: req.user
  });
});

/**
 * POST /admin/battles
 * Create battle from form
 */
router.post("/admin/battles", ensureAuth, ensureBattleAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    // Required strings
    const title = String(body.title || "").trim();
    const category = normalizeCategory(body.category);

    // Dates
    const opensAt = parseDate(body.opensAt);
    const locksAt = parseDate(body.locksAt);
    const endsAt = parseDate(body.endsAt);

    // Numbers
    const entryFeeCents = clamp(toInt(body.entryFeeCents, 100), 0, 50000);
    const platformFeePct = clamp(toInt(body.platformFeePct, 30), 0, 90);
    const minEntries = clamp(toInt(body.minEntries, 20), 2, 200000);
    const durationMinutes = clamp(toInt(body.durationMinutes, 5), 1, 60);
    const questionCount = clamp(toInt(body.questionCount, 10), 3, 50);

    // Quiz filters
    const subject = normalizeSubject(body.subject || "general");
    const grade = clamp(toInt(body.grade, 0), 0, 13);
   const difficultyLabel = String(body.difficulty || "medium").trim().toLowerCase();

const difficultyMap = { easy: 1, medium: 3, hard: 5 };
const difficulty = difficultyMap[difficultyLabel] ?? 3;
    const topics = String(body.topics || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    // Validation
    const errors = [];
    if (!title) errors.push("Title is required");
    if (!category) errors.push("Category is required");
    if (!opensAt || !locksAt || !endsAt) errors.push("All dates are required (opensAt, locksAt, endsAt)");
    if (opensAt && locksAt && opensAt >= locksAt) errors.push("opensAt must be before locksAt");
    if (locksAt && endsAt && locksAt >= endsAt) errors.push("locksAt must be before endsAt");

const allowedDifficulty = new Set(["easy", "medium", "hard"]);
if (!allowedDifficulty.has(difficultyLabel)) errors.push("Difficulty must be easy, medium, or hard");
    if (errors.length) {
      return res.status(400).render("admin/battles/new", {
        user: req.user,
        errors,
        form: body
      });
    }

    // status logic
    const now = new Date();
    let status = "scheduled";
    if (opensAt <= now && locksAt > now) status = "open";
    if (locksAt <= now && endsAt > now) status = "locked";
    if (endsAt <= now) status = "ended";

    const battle = await Battle.create({
      status,
      mode: "arena_blitz",
      title,
      category,
      entryFeeCents,
      platformFeePct,
      minEntries,
      opensAt,
      locksAt,
      endsAt,
      durationMinutes,
      questionCount,
      quiz: { subject, grade, difficulty, topics },
      createdBy: req.user._id
    });

    return res.redirect(`/admin/battles?created=${battle._id}`);
  } catch (err) {
    console.error("[admin battles create]", err);
    return res.status(500).send("Failed to create battle");
  }
});

export default router;