// routes/battles.js
import { Router } from "express";
import crypto from "crypto";
import Battle from "../models/battle.js";
import BattleEntry from "../models/battleEntry.js";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/**
 * Helper: pick questions and lock them
 * MVP: pick from Question bank by subject + (optional) topics
 * grade=0 means "any" (adult public)
 */
async function pickBattleQuestions(battle) {
  const match = {
    type: { $ne: "comprehension" }
  };

  // If subject exists, filter
  if (battle.quiz?.subject && battle.quiz.subject !== "general") {
    match.subject = battle.quiz.subject.toLowerCase();
  }

  // grade: if battle.quiz.grade > 0 use it
  if (battle.quiz?.grade && battle.quiz.grade > 0) {
    match.grade = battle.quiz.grade;
  }

  // topics if provided
  if (Array.isArray(battle.quiz?.topics) && battle.quiz.topics.length) {
    match.topic = { $in: battle.quiz.topics.map(t => String(t).toLowerCase()) };
  }

  // difficulty if you store numeric difficulty on Question
  if (battle.quiz?.difficulty) {
    match.difficulty = battle.quiz.difficulty;
  }

  const sample = await Question.aggregate([
    { $match: match },
    { $sample: { size: battle.questionCount } }
  ]);

  return sample.map(q => q._id);
}

/**
 * GET /battles/open
 * List battles that are open for entry
 */
router.get("/battles/open", ensureAuth, async (req, res) => {
  const now = new Date();
  const battles = await Battle.find({
    status: { $in: ["open"] },
    opensAt: { $lte: now },
    locksAt: { $gt: now }
  })
    .sort({ locksAt: 1 })
    .lean();

  res.json({ success: true, battles });
});

/**
 * POST /battles/create
 * MVP admin endpoint (you can restrict to your admin role later)
 * body: { title, category, entryFeeCents, opensAt, locksAt, endsAt, durationMinutes, questionCount, quiz }
 */
router.post("/battles/create", ensureAuth, async (req, res) => {
  try {
    // 🔒 Minimal restriction: only teachers/admins create
    if (!["private_teacher", "employee"].includes(req.user.role)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const {
      title,
      category,
      entryFeeCents = 100,
      platformFeePct = 30,
      minEntries = 20,
      opensAt,
      locksAt,
      endsAt,
      durationMinutes = 5,
      questionCount = 10,
      quiz = { subject: "general", grade: 0, difficulty: 2, topics: [] }
    } = req.body;

    if (!title || !category || !opensAt || !locksAt || !endsAt) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const battle = await Battle.create({
      status: "open",
      mode: "arena_blitz",
      title,
      category: String(category).toLowerCase(),
      entryFeeCents: Number(entryFeeCents),
      platformFeePct: Number(platformFeePct),
      minEntries: Number(minEntries),
      opensAt: new Date(opensAt),
      locksAt: new Date(locksAt),
      endsAt: new Date(endsAt),
      durationMinutes: Number(durationMinutes),
      questionCount: Number(questionCount),
      quiz
    });

    res.json({ success: true, battle });
  } catch (err) {
    console.error("[Battle Create Error]", err);
    res.status(500).json({ error: "Failed to create battle" });
  }
});

/**
 * POST /battles/:battleId/enter
 * Creates an entry and an ExamInstance, then returns redirectUrl to /lms/quiz.
 * MVP payment: mark as "paid" instantly (you can replace with EcoCash later)
 */
router.post("/battles/:battleId/enter", ensureAuth, async (req, res) => {
  try {
    const { battleId } = req.params;
    const now = new Date();

    const battle = await Battle.findById(battleId);
    if (!battle) return res.status(404).json({ error: "Battle not found" });

    if (battle.status !== "open") return res.status(400).json({ error: "Battle not open" });
    if (!(battle.opensAt <= now && battle.locksAt > now)) {
      return res.status(400).json({ error: "Battle entry closed" });
    }

    // Ensure battle has locked questions (fairness)
    if (!battle.lockedQuestionIds?.length) {
      const qids = await pickBattleQuestions(battle);
      battle.lockedQuestionIds = qids;
      await battle.save();
    }

    // One entry per user per battle
    let entry = await BattleEntry.findOne({ battleId: battle._id, userId: req.user._id });
    if (entry?.examId) {
      // already entered → send them back to quiz (if battle still running)
      return res.json({
        success: true,
        alreadyEntered: true,
        examId: entry.examId,
        redirectUrl: `/lms/quiz?examId=${entry.examId}`
      });
    }

    // ✅ MVP: treat as instantly paid
    entry = await BattleEntry.create({
      battleId: battle._id,
      userId: req.user._id,
      status: "paid"
    });

    // Create ExamInstance that reuses your quiz runner
    const examId = crypto.randomUUID();
    const assignmentId = crypto.randomUUID();

    const questionIds = battle.lockedQuestionIds;

    const choicesOrder = questionIds.map(() => []); 
    // NOTE: Your quiz runner already supports choicesOrder for MCQ shuffling.
    // For now, keep empty arrays; if you want random choice order later, we can fill this.

    await ExamInstance.create({
      examId,
      assignmentId,
      userId: req.user._id,
      org: null, // public user, no org
      targetRole: "student", // or "public_player" later; keep neutral for now
      module: battle.category,
      title: `Battle: ${battle.title}`,
      quizTitle: `Battle: ${battle.title}`,
      questionIds,
      choicesOrder,
      durationMinutes: battle.durationMinutes,
      status: "pending",
      meta: {
        isBattle: true,
        battleId: String(battle._id),
        battleMode: battle.mode,
        entryFeeCents: battle.entryFeeCents
      }
    });

    entry.examId = examId;
    entry.status = "started";
    await entry.save();

    // increment entryCount safely
    await Battle.updateOne({ _id: battle._id }, { $inc: { entryCount: 1 } });

    return res.json({
      success: true,
      battleId: String(battle._id),
      examId,
      redirectUrl: `/lms/quiz?examId=${examId}`
    });
  } catch (err) {
    console.error("[Battle Enter Error]", err);
    res.status(500).json({ error: "Failed to enter battle" });
  }
});

/**
 * POST /battles/:battleId/record-result
 * Called by your attempt-finalization code (Step 4).
 * body: { examId, percentage, score, maxScore, timeTakenSec }
 */
router.post("/battles/:battleId/record-result", ensureAuth, async (req, res) => {
  try {
    const { battleId } = req.params;
    const { examId, percentage, score, maxScore, timeTakenSec } = req.body;

    if (!examId) return res.status(400).json({ error: "Missing examId" });

    const entry = await BattleEntry.findOne({ battleId, userId: req.user._id, examId });
    if (!entry) return res.status(404).json({ error: "Entry not found" });

    entry.status = "finished";
    entry.scorePct = Number(percentage);
    entry.correctCount = score != null ? Number(score) : null;
    entry.maxScore = maxScore != null ? Number(maxScore) : null;
    entry.timeTakenSec = timeTakenSec != null ? Number(timeTakenSec) : null;
    await entry.save();

    res.json({ success: true });
  } catch (err) {
    console.error("[Battle Record Result Error]", err);
    res.status(500).json({ error: "Failed to record result" });
  }
});

export default router;