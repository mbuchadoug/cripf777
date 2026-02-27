// routes/battles.js
import { Router } from "express";
import crypto from "crypto";
import Battle from "../models/battle.js";
import BattleEntry from "../models/battleEntry.js";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import { ensureAuth } from "../middleware/authGuard.js";
import AIQuiz from "../models/aiQuiz.js";

const router = Router();


function nowJoinable(battle, now = new Date()) {
  return battle.opensAt <= now && battle.locksAt > now;
}

function nowStartable(battle, now = new Date()) {
  // after locksAt, before endsAt
  return battle.locksAt <= now && battle.endsAt > now;
}
/**
 * Helper: pick questions and lock them
 * MVP: pick from Question bank by subject + (optional) topics
 * grade=0 means "any" (adult public)
 */
function difficultyNumToLabel(n) {
  const map = { 1: "easy", 2: "easy", 3: "medium", 4: "hard", 5: "hard" };
  return map[Number(n)] || "medium";
}

async function pickBattleQuestionRefs(battle) {
  const need = Number(battle.questionCount) || 10;
  const source = battle.quiz?.source || "mixed";

  const refs = [];

  /* =========================
     1) QUESTION BANK (Question collection)
  ========================== */
  async function pickFromBank(maxNeeded) {
    const match = { type: { $ne: "comprehension" } };

    if (battle.quiz?.subject && battle.quiz.subject !== "general") {
      match.subject = String(battle.quiz.subject).toLowerCase();
    }

    // NOTE: grade=0 means ANY (so skip)
    if (battle.quiz?.grade && Number(battle.quiz.grade) > 0) {
      match.grade = Number(battle.quiz.grade);
    }

    // topics (your bank uses `topic` as a string)
    if (Array.isArray(battle.quiz?.topics) && battle.quiz.topics.length) {
      match.topic = { $in: battle.quiz.topics.map(t => String(t).toLowerCase()) };
    }

    // bank difficulty is numeric
    if (battle.quiz?.difficulty) {
      match.difficulty = Number(battle.quiz.difficulty);
    }

    const sample = await Question.aggregate([
      { $match: match },
      { $sample: { size: maxNeeded } }
    ]);

    return sample.map(q => String(q._id));
  }

  /* =========================
     2) AI QUIZZES (AIQuiz collection)
     - AIQuiz difficulty is STRING: "easy/medium/hard"
     - AIQuiz topic is SINGLE string field: "topic"
     - Questions are embedded -> reference them as "ai:<quizId>:<idx>"
  ========================== */
  async function pickFromAI(maxNeeded) {
    const match = { status: "active" };

    if (battle.quiz?.subject && battle.quiz.subject !== "general") {
      match.subject = String(battle.quiz.subject).toLowerCase();
    }

    // grade=0 means ANY (skip)
    if (battle.quiz?.grade && Number(battle.quiz.grade) > 0) {
      match.grade = Number(battle.quiz.grade);
    }

    // topics: AIQuiz has ONE topic field, so match if its in the list
    if (Array.isArray(battle.quiz?.topics) && battle.quiz.topics.length) {
      match.topic = { $in: battle.quiz.topics.map(t => String(t).toLowerCase()) };
    }

    // AIQuiz difficulty is string
    if (battle.quiz?.difficulty) {
      match.difficulty = difficultyNumToLabel(battle.quiz.difficulty);
    }

    // Find AIQuizzes that can supply questions
    const candidates = await AIQuiz.find(match)
      .select("_id questions questionCount")
      .lean();

    if (!candidates.length) return [];

    // Flatten into (quizId, idx) pairs to sample across many quizzes
    const pool = [];
    for (const qz of candidates) {
      const qs = Array.isArray(qz.questions) ? qz.questions : [];
      for (let i = 0; i < qs.length; i++) {
        pool.push(`ai:${qz._id}:${i}`);
      }
    }

    if (!pool.length) return [];

    // Random pick without duplicates
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    return pool.slice(0, maxNeeded);
  }

  // Decide source
  if (source === "bank") {
    refs.push(...(await pickFromBank(need)));
  } else if (source === "ai") {
    refs.push(...(await pickFromAI(need)));
  } else {
    // mixed: bank first, then AI fallback
    const fromBank = await pickFromBank(need);
    refs.push(...fromBank);

    if (refs.length < need) {
      const fromAI = await pickFromAI(need - refs.length);
      refs.push(...fromAI);
    }
  }

  return refs.slice(0, need);
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

    const battle = await Battle.findById(battleId).lean();
    if (!battle) return res.status(404).json({ error: "Battle not found" });

    // Joinable window: opensAt <= now < locksAt
    if (!nowJoinable(battle, now)) {
      return res.status(400).json({ error: "Battle entry not open" });
    }

    // Ensure there is an entry doc (one per user per battle)
    let entry = await BattleEntry.findOne({ battleId, userId: req.user._id });

    if (!entry) {
      // ✅ MVP: treat payment as instant "paid" for now (EcoCash later)
      entry = await BattleEntry.create({
        battleId,
        userId: req.user._id,
        status: "paid"
      });

      // increment entryCount safely
      await Battle.updateOne({ _id: battleId }, { $inc: { entryCount: 1 } });
    }

    // If they already have an examId, they previously started → send them back
    if (entry.examId) {
      return res.json({
        success: true,
        alreadyStarted: true,
        examId: entry.examId,
        redirectUrl: `/lms/quiz?examId=${entry.examId}`
      });
    }

    // ✅ Entered, but quiz not started yet → go to lobby
    return res.json({
      success: true,
      entered: true,
      battleId: String(battleId),
      redirectUrl: `/arena/lobby?battleId=${battleId}`
    });
  } catch (err) {
    console.error("[Battle Enter Error]", err);
    res.status(500).json({ error: "Failed to enter battle" });
  }
});


router.get("/battles/:battleId/lobby", ensureAuth, async (req, res) => {
  const { battleId } = req.params;
  const now = new Date();

  const battle = await Battle.findById(battleId).lean();
  if (!battle) return res.status(404).json({ error: "Battle not found" });

  const entry = await BattleEntry.findOne({
    battleId,
    userId: req.user._id
  }).lean();

  res.json({
    success: true,
    now,
    battle,
    entry,
    joinable: nowJoinable(battle, now),
    startable: nowStartable(battle, now)
  });
});


router.post("/battles/:battleId/start", ensureAuth, async (req, res) => {
  try {
    const { battleId } = req.params;
    const now = new Date();

    const battle = await Battle.findById(battleId);
    if (!battle) return res.status(404).json({ error: "Battle not found" });

    // Only allow start AFTER locksAt and BEFORE endsAt
    if (!nowStartable(battle, now)) {
      return res.status(400).json({ error: "Battle not started yet" });
    }

    // Must be entered
    const entry = await BattleEntry.findOne({
      battleId: battle._id,
      userId: req.user._id
    });

    if (!entry) return res.status(403).json({ error: "You have not entered this battle" });

    // If already started, return existing
    if (entry.examId) {
      return res.json({
        success: true,
        alreadyStarted: true,
        examId: entry.examId,
        redirectUrl: `/lms/quiz?examId=${entry.examId}`
      });
    }

    // Ensure battle has locked questions (fairness)
if (!battle.lockedQuestionIds?.length) {
  const refs = await pickBattleQuestionRefs(battle);

  if (!refs || refs.length < battle.questionCount) {
    return res.status(400).json({
      error: `Not enough questions found. Needed ${battle.questionCount}, got ${refs?.length || 0}. Check battle filters (subject/topic/grade/difficulty/source).`
    });
  }

  battle.lockedQuestionIds = refs; // refs are STRINGS now
  await battle.save();

  console.log("[battle start] lockedQuestionIds locked:", refs.length, "source:", battle.quiz?.source);
}

    const examId = crypto.randomUUID();
    const assignmentId = crypto.randomUUID();

const questionIds = (battle.lockedQuestionIds || []).map(String);

// Build choicesOrder:
// - bank questions: keep []
// - AI questions: use [0..n-1] based on AIQuiz question choices length
const choicesOrder = [];
const aiTokens = questionIds.filter(id => String(id).startsWith("ai:"));

const aiByQuiz = {};
for (const tok of aiTokens) {
  const parts = String(tok).split(":"); // ai:<quizId>:<idx>
  const quizId = parts[1];
  const idx = Number(parts[2]);
  if (!aiByQuiz[quizId]) aiByQuiz[quizId] = [];
  aiByQuiz[quizId].push(idx);
}

// preload AI quizzes once
const aiQuizDocs = {};
const quizIds = Object.keys(aiByQuiz);
if (quizIds.length) {
  const docs = await AIQuiz.find({ _id: { $in: quizIds } }).select("_id questions").lean();
  for (const d of docs) aiQuizDocs[String(d._id)] = d;
}

for (const qid of questionIds) {
  if (!String(qid).startsWith("ai:")) {
    choicesOrder.push([]); // bank = let runner handle
    continue;
  }
  const [, quizId, idxStr] = String(qid).split(":");
  const idx = Number(idxStr);
  const quiz = aiQuizDocs[String(quizId)];
  const q = quiz?.questions?.[idx];
  const len = Array.isArray(q?.choices) ? q.choices.length : 0;
  choicesOrder.push(len ? Array.from({ length: len }, (_, i) => i) : []);
}

    await ExamInstance.create({
      examId,
      assignmentId,
      userId: req.user._id,
      org: null,
      targetRole: "student",
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

    return res.json({
      success: true,
      battleId: String(battle._id),
      examId,
      redirectUrl: `/lms/quiz?examId=${examId}`
    });
  } catch (err) {
    console.error("[Battle Start Error]", err);
    res.status(500).json({ error: "Failed to start battle" });
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

/**
 * GET /battles/arena-feed
 * Returns: { openBattle, nextBattle }
 * - openBattle: battle currently joinable
 * - nextBattle: next scheduled battle (soonest opensAt in the future)
 */
router.get("/battles/arena-feed", ensureAuth, async (req, res) => {
  const now = new Date();

  // ✅ OPEN/JOINABLE battle by TIME WINDOW (don’t rely only on status)
  const openBattle = await Battle.findOne({
    opensAt: { $lte: now },
    locksAt: { $gt: now },
    endsAt: { $gt: now },
    status: { $in: ["open", "scheduled"] } // scheduler may not have flipped yet
  })
    .sort({ locksAt: 1 })
    .lean();

  // ✅ Next battle in the future
  const nextBattle = openBattle
    ? null
    : await Battle.findOne({
        opensAt: { $gt: now },
        endsAt: { $gt: now },
        status: { $in: ["scheduled", "draft", "open"] } // open but not joinable shouldn’t happen, but safe
      })
        .sort({ opensAt: 1 })
        .lean();

  // User’s entry state (so UI can show "Continue" if already entered)
  let entry = null;
  if (openBattle?._id) {
    entry = await BattleEntry.findOne({
      battleId: openBattle._id,
      userId: req.user._id
    }).lean();
  } else if (nextBattle?._id) {
    entry = await BattleEntry.findOne({
      battleId: nextBattle._id,
      userId: req.user._id
    }).lean();
  }

  res.json({ success: true, openBattle, nextBattle, now, entry });
});

export default router;