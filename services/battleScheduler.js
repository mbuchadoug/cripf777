// services/battleScheduler.js
import crypto from "crypto";
import SchedulerLock from "../models/schedulerLock.js";
import Battle from "../models/battle.js";
import Question from "../models/question.js";

const INSTANCE_ID =
  process.env.INSTANCE_ID ||
  process.env.HOSTNAME ||
  crypto.randomUUID();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Acquire a distributed lock in Mongo.
 * Only ONE instance will succeed at a time.
 */
async function acquireLock({ key, ttlMs }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    // Only acquire if lock is expired OR already owned by this instance
    await SchedulerLock.updateOne(
      {
        key,
        $or: [
          { expiresAt: { $lte: now } },
          { ownerId: INSTANCE_ID } // allow refresh if we already hold it
        ]
      },
      {
        $set: { ownerId: INSTANCE_ID, expiresAt }
      },
      { upsert: true }
    );
  } catch (e) {
    // ✅ Multi-instance race on first insert → treat as "someone else got it"
    if (e && (e.code === 11000 || String(e.message || "").includes("E11000"))) {
      return false;
    }
    throw e;
  }

  // Confirm ownership
  const lock = await SchedulerLock.findOne({ key }).lean();
  return !!lock && lock.ownerId === INSTANCE_ID && lock.expiresAt > now;
}

/**
 * Helper: pick and lock questions for a battle
 * Ensures we never pick comprehension questions
 */
async function pickBattleQuestions(battle) {
  const match = {
    type: { $ne: "comprehension" }
  };

  if (battle.quiz?.subject && battle.quiz.subject !== "general") {
    match.subject = String(battle.quiz.subject).toLowerCase();
  }

  if (battle.quiz?.grade && battle.quiz.grade > 0) {
    match.grade = battle.quiz.grade;
  }

  if (Array.isArray(battle.quiz?.topics) && battle.quiz.topics.length) {
    match.topic = { $in: battle.quiz.topics.map(t => String(t).toLowerCase()) };
  }

  if (battle.quiz?.difficulty) {
    match.difficulty = battle.quiz.difficulty;
  }

  const size = Math.max(1, Math.min(50, Number(battle.questionCount || 10)));

  const sample = await Question.aggregate([
    { $match: match },
    { $sample: { size } }
  ]);

  return sample.map(q => q._id);
}

/**
 * One scheduler tick: transitions statuses + locks questions once
 */
async function runBattleTick() {
  const now = new Date();

  // 1) scheduled -> open
  await Battle.updateMany(
    {
      status: "scheduled",
      opensAt: { $lte: now },
      locksAt: { $gt: now }
    },
    { $set: { status: "open" } }
  );

  // 2) open/scheduled -> locked (when lock time passed)
  await Battle.updateMany(
    {
      status: { $in: ["scheduled", "open"] },
      locksAt: { $lte: now },
      endsAt: { $gt: now }
    },
    { $set: { status: "locked" } }
  );

  // 3) any -> ended (when endsAt passed)
  await Battle.updateMany(
    {
      status: { $in: ["scheduled", "open", "locked"] },
      endsAt: { $lte: now }
    },
    { $set: { status: "ended" } }
  );

  // 4) Lock questions ONCE for battles that are now locked and still have none
  // We fetch a small batch and process them one-by-one safely.
  const toLock = await Battle.find({
    status: "locked",
    $or: [
      { lockedQuestionIds: { $exists: false } },
      { lockedQuestionIds: { $size: 0 } }
    ]
  })
    .limit(20)
    .lean();

  for (const b of toLock) {
    // Double-check with atomic conditional update so no race
    const qids = await pickBattleQuestions(b);

    // If no questions found, skip but keep battle locked (admin should fix question bank)
    if (!qids.length) continue;

    await Battle.updateOne(
      {
        _id: b._id,
        status: "locked",
        $or: [
          { lockedQuestionIds: { $exists: false } },
          { lockedQuestionIds: { $size: 0 } }
        ]
      },
      { $set: { lockedQuestionIds: qids } }
    );
  }
}

/**
 * Start scheduler loop.
 * In multi-instance mode, lock ensures only one runs per tick.
 */
export function startBattleScheduler({
  intervalMs = 30000,
  lockTtlMs = 25000,
  enabled = true
} = {}) {
  if (!enabled) {
    console.log("[battleScheduler] disabled");
    return;
  }

  console.log("[battleScheduler] starting", { INSTANCE_ID, intervalMs, lockTtlMs });

  (async function loop() {
    while (true) {
      try {
        const gotLock = await acquireLock({ key: "battleScheduler", ttlMs: lockTtlMs });

        if (gotLock) {
          await runBattleTick();
        }
      } catch (e) {
        console.error("[battleScheduler] tick error:", e && (e.stack || e.message || e));
      }

      await sleep(intervalMs);
    }
  })();
}