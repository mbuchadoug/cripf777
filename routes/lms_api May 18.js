import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import Question from "../models/question.js";         // Question model (used throughout)
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";
import Certificate from "../models/certificate.js";
import { updateTopicMasteryFromAttempt } from "../services/topicMasteryTracker.js";
import BattleEntry from "../models/battleEntry.js";
import Battle from "../models/battle.js";
const router = Router();

// fallback file loader
function fetchRandomQuestionsFromFile(count = 5) {
  try {
    const p = path.join(process.cwd(), "data", "data_questions.json");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const all = JSON.parse(raw);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, count).map((d) => ({
      id: d.id || d._id || d.uuid || "fid-" + Math.random().toString(36).slice(2, 9),
      text: d.text,
      choices: (d.choices || []).map((c) => (typeof c === "string" ? { text: c } : { text: c.text || c })),
      correctIndex:
        typeof d.correctIndex === "number"
          ? d.correctIndex
          : typeof d.answerIndex === "number"
          ? d.answerIndex
          : null,
      tags: d.tags || [],
      difficulty: d.difficulty || "medium",
    }));
  } catch (err) {
    console.error("[fetchRandomQuestionsFromFile] error:", err && (err.stack || err));
    return [];
  }
}



async function recordBattleResultFromExam({ exam, userId, examId, percentage, score, maxScore, timeTakenSec }) {
  try {
    const battleIdRaw = exam?.meta?.battleId;
    const battleId = mongoose.isValidObjectId(battleIdRaw)
      ? new mongoose.Types.ObjectId(battleIdRaw)
      : null;

    const isBattle = !!exam?.meta?.isBattle;
    if (!isBattle || !battleId || !userId) return;

    const safePct = Number.isFinite(Number(percentage)) ? Number(percentage) : 0;
    const safeTime = Number.isFinite(Number(timeTakenSec)) ? Number(timeTakenSec) : 999999;
    const safeScore = score != null ? Number(score) : null;
    const safeMax = maxScore != null ? Number(maxScore) : null;

    // ✅ Find entry by battleId+userId (unique index already exists)
    // ✅ Always set examId if provided (so "Continue" works)
   const setDoc = {
  status: "finished",
  scorePct: safePct,
  correctCount: safeScore,
  maxScore: safeMax,
  timeTakenSec: safeTime
};

if (examId) setDoc.examId = String(examId);

await BattleEntry.updateOne(
 { battleId, userId, status: { $ne: "void" } },
  { $set: setDoc }
);

  } catch (e) {
    console.error("[battle] failed to record result:", e && (e.stack || e.message || e));
  }
}
/**
 * GET /api/lms/quiz?count=5&module=responsibility&org=muono
 * create small ExamInstance that contains questionIds and (optionally) choicesOrder
 */
// GET /api/lms/quiz?count=5&module=responsibility&org=muono
// GET /api/lms/quiz?count=5&module=...&org=...  OR  /api/lms/quiz?examId=...
router.get("/quiz", async (req, res) => {
  try {
    const examIdParam = String(req.query.examId || "").trim();

    // ⏱️ Ensure Attempt exists with startedAt when quiz is opened
// ⏱️ Ensure Attempt exists with startedAt when quiz is opened
if (examIdParam && req.user) {
  await Attempt.findOneAndUpdate(
    {
      examId: examIdParam,
      userId: req.user._id
    },
    {
      $setOnInsert: {
        examId: examIdParam,
        userId: req.user._id,
        startedAt: new Date(),
        status: "in_progress"
      }
    },
    { upsert: true }
  );
}


    let count = parseInt(req.query.count || "5", 10);
    if (!Number.isFinite(count)) count = 5;
    count = Math.max(1, Math.min(50, count));

    const moduleName = String(req.query.module || "").trim();
    const orgSlug = String(req.query.org || "").trim();

    // helper to load file fallback
    function loadFileQuestionsMap() {
      const map = {};
      try {
        const p = path.join(process.cwd(), "data", "data_questions.json");
        if (!fs.existsSync(p)) return map;
        const arr = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const q of arr) {
          const id = String(q.id || q._id || q.uuid || "");
          if (id) map[id] = q;
        }
      } catch (e) {
        console.warn("[/api/lms/quiz] file fallback load failed:", e && e.message);
      }
      return map;
    }
    const fileQuestionsMap = loadFileQuestionsMap();

    // Normalize exam.questionIds that might be stored as array or JSON string
    function normalizeIds(raw) {
      if (raw === undefined || raw === null) return [];
      if (Array.isArray(raw)) return raw.map(String);
      if (typeof raw === "string") {
        const t = raw.trim();
        if (!t) return [];
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed)) return parsed.map(String);
        } catch (e) {
          // fallback to split tokens / extract tokens
          // first capture parent:... tokens and 24-hex ids
          const tokens = [];
          const parentMatches = t.match(/parent:([0-9a-fA-F]{24})/g) || [];
          parentMatches.forEach(m => {
            const pid = m.split(':')[1].replace(/[^0-9a-fA-F]/g,'');
            if (pid) tokens.push(`parent:${pid}`);
          });
          const objMatches = t.match(/[0-9a-fA-F]{24}/g) || [];
          objMatches.forEach(m => tokens.push(m));
          // also add comma/space separated parts
          const parts = t.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
          for (const p of parts) if (!tokens.includes(p)) tokens.push(p);
          return tokens;
        }
      }
      return [String(raw)];
    }

    // If examId was supplied: return exact exam spec, expanding parents inline
    if (examIdParam) {
      try {
        const exam = await ExamInstance.findOne({ examId: examIdParam }).lean();
        const canonicalExamId = exam?.examId || examIdParam;

        // ✅ STEP 13: CHECK IF THIS IS AN AI-GENERATED QUIZ
let questions = []; // Will hold the final question list

if (exam?.meta?.isAIGenerated && exam?.meta?.aiQuizId) {
  console.log("[AI Quiz] Loading AI-generated questions for:", exam.meta.aiQuizId);
  
  try {
    const AIQuiz = (await import("../models/aiQuiz.js")).default;
    const aiQuiz = await AIQuiz.findById(exam.meta.aiQuizId).lean();
    
    if (aiQuiz && Array.isArray(aiQuiz.questions)) {
      // Map AI questions to standard format
      const series = aiQuiz.questions.map((q, idx) => ({
        id: `ai:${aiQuiz._id}:${idx}`,
        text: q.text,
        choices: q.choices.map(c => ({ text: c })),
        choicesOrder: Array.from({ length: q.choices.length }, (_, i) => i),
        correctIndex: q.correctIndex, // Don't expose to client in production
        explanation: q.explanation,
        tags: [`ai-generated`, `difficulty:${aiQuiz.difficulty}`],
        difficulty: aiQuiz.difficulty
      }));

      // Return AI quiz immediately
      return res.json({
        examId: exam.examId,
        quizTitle: aiQuiz.title,
        expiresAt: exam.expiresAt || null,
        durationMinutes: exam.durationMinutes || null,
        serverTime: new Date(),
        series
      });
    } else {
      console.warn("[AI Quiz] AIQuiz found but no questions:", exam.meta.aiQuizId);
    }
  } catch (aiError) {
    console.error("[AI Quiz] Failed to load AI quiz:", aiError);
    // Fall through to regular question loading
  }
}

        // 🔑 RESOLVE REAL QUIZ TITLE FROM PARENT QUESTION
let resolvedQuizTitle = exam.quizTitle || exam.title || null;

try {
  const parentToken = (exam.questionIds || []).find(q =>
    typeof q === "string" && q.startsWith("parent:")
  );

  if (parentToken) {
    const parentId = parentToken.split(":")[1];
    if (mongoose.isValidObjectId(parentId)) {
      const parentQuestion = await Question.findById(parentId)
        .select("text")
        .lean();

      if (parentQuestion?.text) {
        resolvedQuizTitle = parentQuestion.text.trim();
      }
    }
  }
} catch (e) {
  console.warn("[quiz title] failed to resolve parent title", e.message);
}

        if (!exam) return res.status(404).json({ error: "exam instance not found" });

        const rawList = normalizeIds(exam.questionIds || []);
        // ✅ AI TOKEN SUPPORT: ai:<aiQuizId>:<idx>
const aiTokens = rawList.filter(t => typeof t === "string" && t.startsWith("ai:"));
const aiGroups = {}; // aiQuizId -> Set(indices)
for (const tok of aiTokens) {
  const parts = String(tok).split(":"); // ["ai", quizId, idx]
  const quizId = parts[1];
  const idx = Number(parts[2]);
  if (!quizId || !Number.isFinite(idx)) continue;
  if (!aiGroups[quizId]) aiGroups[quizId] = new Set();
  aiGroups[quizId].add(idx);
}

const aiQuizMap = {}; // quizId -> AIQuiz doc
if (Object.keys(aiGroups).length) {
  try {
    const AIQuiz = (await import("../models/aiQuiz.js")).default;
    const validIds = Object.keys(aiGroups).filter(id => mongoose.isValidObjectId(id));
    if (validIds.length) {
      const docs = await AIQuiz.find({ _id: { $in: validIds } })
        .select("_id questions difficulty subject topic grade")
        .lean();
      for (const d of docs) aiQuizMap[String(d._id)] = d;
    }
  } catch (e) {
    console.warn("[/api/lms/quiz] AIQuiz preload failed:", e?.message);
  }
}

function normalizeAIChoices(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    if (typeof c === "string") return { text: c };
    if (c && typeof c === "object") return { text: String(c.text ?? c.label ?? "") };
    return { text: String(c ?? "") };
  });
}
        // We'll collect DB ids to fetch (parents + children + normal q ids)
        const dbIdSet = new Set();
        const parentTokens = []; // keep list of parent ids encountered in order

        // First pass: collect object ids we may need to fetch
        for (const token of rawList) {
          if (!token) continue;
          if (String(token).startsWith("parent:")) {
            const pid = String(token).split(":")[1] || "";
            parentTokens.push(pid);





            if (mongoose.isValidObjectId(pid)) dbIdSet.add(pid);
          } else if (mongoose.isValidObjectId(token)) {
            dbIdSet.add(token);
          } else {
            // non-ObjectId tokens map to fileQuestionsMap maybe
          }
        }

        // Fetch all referenced DB docs (parents and any direct question ids)
        let fetched = [];
        if (dbIdSet.size) {
          const objIds = Array.from(dbIdSet).map(id => mongoose.Types.ObjectId(id));
          fetched = await Question.find({ _id: { $in: objIds } }).lean().exec();
        }
        const byId = {};
        // FIX: correct property name and populate byId correctly
        for (const d of fetched) byId[String(d._id)] = d;

        // For each parent, collect its child IDs and fetch children as needed
        const childIdSet = new Set();
        for (const pid of parentTokens) {
          const pdoc = byId[pid];
          if (pdoc && Array.isArray(pdoc.questionIds)) {
            for (const cid of pdoc.questionIds.map(String)) {
              if (cid) childIdSet.add(cid);
            }
          } else if (fileQuestionsMap[`parent:${pid}`]) {
            // unlikely, but keep for completeness
          }
        }

        // Fetch child docs if they look like ObjectIds
        const childObjIds = Array.from(childIdSet).filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
        if (childObjIds.length) {
          const childDocs = await Question.find({ _id: { $in: childObjIds } }).lean().exec();
          for (const c of childDocs) byId[String(c._id)] = c;
        }

        // Build the output series while preserving order and avoiding duplicates:
        const emittedChildIds = new Set(); // used to skip duplicates if child appears later in rawList
        const series = [];

        // helper to apply saved choicesOrder mapping for a question's choices
        // This version accepts either mapping shape:
        //  - mapping[displayIndex] = originalIndex  (display->original)  OR
        //  - mapping[originalIndex] = displayIndex  (original->display)
        // It normalizes to display->original and returns both displayedChoices and the mapping.
        function applyChoicesOrder(originalChoices, mapping) {
          // normalize original choices to objects
          const norm = (originalChoices || []).map(c =>
            (typeof c === 'string' ? { text: c } : (c && c.text ? { text: c.text } : { text: String(c || '') }))
          );

          const n = norm.length;
          // identity mapping
          const identityOrder = Array.from({ length: n }, (_, i) => i);

          if (!Array.isArray(mapping) || mapping.length !== n) {
            return { displayedChoices: norm, choicesOrder: identityOrder };
          }

          // validate permutation helper
          function isValidPermutation(arr) {
            const seen = new Array(arr.length).fill(false);
            for (let i = 0; i < arr.length; i++) {
              const v = arr[i];
              if (typeof v !== 'number' || v < 0 || v >= arr.length || !Number.isInteger(v)) return false;
              if (seen[v]) return false;
              seen[v] = true;
            }
            return true;
          }

          // mapping might already be display->original (mapping[display]=original)
          let displayToOriginal = mapping.slice();
          if (!isValidPermutation(displayToOriginal)) {
            // try invert: mapping[original] = display -> produce display->original
            const inv = new Array(n).fill(undefined);
            let ok = true;
            for (let orig = 0; orig < mapping.length; orig++) {
              const disp = mapping[orig];
              if (typeof disp !== 'number' || !Number.isInteger(disp) || disp < 0 || disp >= n) { ok = false; break; }
              if (typeof inv[disp] !== 'undefined') { ok = false; break; }
              inv[disp] = orig;
            }
            if (ok && inv.every(x => typeof x === 'number')) {
              displayToOriginal = inv;
            } else {
              // malformed mapping -> return identity
              return { displayedChoices: norm, choicesOrder: identityOrder };
            }
          }

          const displayedChoices = displayToOriginal.map(origIdx => norm[origIdx] || { text: '' });
          return { displayedChoices, choicesOrder: displayToOriginal };
        }

        for (const token of rawList) {
          if (!token) continue;

          // parent marker --> expand into a comprehension entry with ordered children
          if (String(token).startsWith("parent:")) {
            const pid = String(token).split(":")[1] || "";
            // prefer DB parent doc, otherwise try file fallback keyed by plain id
            const parentDoc = byId[pid] || fileQuestionsMap[pid] || null;
            if (!parentDoc) {
              // skip if missing
              continue;
            }

            // produce ordered children list (preserve parent's questionIds order)
            const orderedChildIds = Array.isArray(parentDoc.questionIds) ? parentDoc.questionIds.map(String) : [];
            const orderedChildren = [];
            for (const cid of orderedChildIds) {
              if (!cid) continue;
              // skip child if we've already emitted it (prevents duplicates)
              if (emittedChildIds.has(cid)) continue;

              // prefer DB doc if present
              if (byId[cid]) {
                const c = byId[cid];

                // build original choices
                const originalChoices = (c.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: ch.text || "" }));

                // find position of this question in the exam.questionIds to pick mapping
                let qPos = null;
                if (Array.isArray(exam.questionIds)) {
                  for (let ii = 0; ii < exam.questionIds.length; ii++) {
                    if (String(exam.questionIds[ii]) === String(cid)) { qPos = ii; break; }
                  }
                }
                const mapping = (Array.isArray(exam.choicesOrder) && qPos !== null) ? exam.choicesOrder[qPos] : null;
                const { displayedChoices, choicesOrder } = applyChoicesOrder(originalChoices, mapping || null);

                orderedChildren.push({
                  id: String(c._id),
                  text: c.text,
                  choices: displayedChoices,
                  choicesOrder: Array.isArray(choicesOrder) ? choicesOrder : null,
                  tags: c.tags || [],
                  difficulty: c.difficulty || "medium"
                });
                emittedChildIds.add(cid);
                continue;
              }

              // fallback to file map
              if (fileQuestionsMap[cid]) {
                const fq = fileQuestionsMap[cid];
                const origChoices = (fq.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: ch.text || "" }));
                const { displayedChoices, choicesOrder } = applyChoicesOrder(origChoices, null);

                orderedChildren.push({
                  id: cid,
                  text: fq.text,
                  choices: displayedChoices,
                  choicesOrder: Array.isArray(choicesOrder) ? choicesOrder : null,
                  tags: fq.tags || [],
                  difficulty: fq.difficulty || "medium"
                });
                emittedChildIds.add(cid);
                continue;
              }

              // If child missing, skip gracefully
            }

            series.push({
              id: String(parentDoc._id || parentDoc.id || pid),
              type: "comprehension",
              passage: parentDoc.passage || parentDoc.text || "",
              children: orderedChildren,
              tags: parentDoc.tags || [],
              difficulty: parentDoc.difficulty || "medium"
            });

            continue;
          }


// ✅ AI token -> expand embedded AIQuiz question into MCQ
if (String(token).startsWith("ai:")) {
  const [_, quizId, idxStr] = String(token).split(":");
  const idx = Number(idxStr);

  const aq = aiQuizMap[String(quizId)];
  const q = aq?.questions?.[idx];
  if (!aq || !q) continue;

  const originalChoices = normalizeAIChoices(q.choices);

  // find q position in exam.questionIds to pick mapping
  let qPos = null;
  if (Array.isArray(exam.questionIds)) {
    for (let ii = 0; ii < exam.questionIds.length; ii++) {
      if (String(exam.questionIds[ii]) === String(token)) { qPos = ii; break; }
    }
  }

  const mapping =
    (Array.isArray(exam.choicesOrder) && qPos !== null)
      ? exam.choicesOrder[qPos]
      : null;

  const { displayedChoices, choicesOrder } =
    applyChoicesOrder(originalChoices, mapping || null);

  series.push({
    id: String(token), // keep token id
    text: String(q.text || ""),
    choices: displayedChoices,
    choicesOrder: Array.isArray(choicesOrder) ? choicesOrder : null,
    tags: ["ai", ...(aq.topic ? [String(aq.topic)] : [])],
    difficulty: aq.difficulty || "medium"
  });

  continue;
}


          // Normal question token (DB id or file id)
          // If token corresponds to a child that was already emitted as part of a parent, skip it
          if (emittedChildIds.has(String(token))) {
            // skip duplicate child
            continue;
          }

          if (mongoose.isValidObjectId(token)) {
            const qdoc = byId[token];
            if (!qdoc) {
              // question missing from DB (skip)
              continue;
            }

            // build original choices
            const originalChoices = (qdoc.choices || []).map(c => (typeof c === "string" ? { text: c } : { text: c.text || '' }));

            // find q position in exam.questionIds
            let qPos = null;
            if (Array.isArray(exam.questionIds)) {
              for (let ii = 0; ii < exam.questionIds.length; ii++) {
                if (String(exam.questionIds[ii]) === String(token)) { qPos = ii; break; }
              }
            }
            const mapping = (Array.isArray(exam.choicesOrder) && qPos !== null) ? exam.choicesOrder[qPos] : null;
            const { displayedChoices, choicesOrder } = applyChoicesOrder(originalChoices, mapping || null);

            series.push({
              id: String(qdoc._id),
              text: qdoc.text,
              choices: displayedChoices,
              choicesOrder: Array.isArray(choicesOrder) ? choicesOrder : null,
              tags: qdoc.tags || [],
              difficulty: qdoc.difficulty || 'medium'
            });
            continue;
          }

          // Non-object token -> file fallback
          if (fileQuestionsMap[token]) {
            const fq = fileQuestionsMap[token];
            // ensure not duplicate
            if (emittedChildIds.has(token)) continue;
            const origChoices = (fq.choices || []).map(c => (typeof c === "string" ? { text: c } : { text: c.text || '' }));
            const { displayedChoices, choicesOrder } = applyChoicesOrder(origChoices, null);
            series.push({
              id: token,
              text: fq.text,
              choices: displayedChoices,
              choicesOrder: Array.isArray(choicesOrder) ? choicesOrder : null,
              tags: fq.tags || [],
              difficulty: fq.difficulty || 'medium'
            });
            emittedChildIds.add(token);
            continue;
          }

          // unknown token -> skip
        }

       // return res.json({ examId: exam.examId, series });
return res.json({
  examId: exam.examId,
  quizTitle: resolvedQuizTitle, // ✅ REAL TITLE
  expiresAt: exam.expiresAt || null,
  durationMinutes: exam.durationMinutes || null,
  serverTime: new Date(),
  series
});



      } catch (e) {
        console.error("[/api/lms/quiz] exam load error:", e && (e.stack || e));
        return res.status(500).json({ error: "failed to load exam instance" });
      }
    } // end examId branch

    // ----- Sampling branch (no examId) -----
    try {
      // org filter
      const match = {};
      if (moduleName) match.module = { $regex: new RegExp(`^${moduleName}$`, "i") };

      if (orgSlug) {
        const org = await Organization.findOne({ slug: orgSlug }).lean();
        if (org) match.$or = [{ organization: org._id }, { organization: null }, { organization: { $exists: false } }];
        else match.$or = [{ organization: null }, { organization: { $exists: false } }];
      } else {
        match.$or = [{ organization: null }, { organization: { $exists: false } }];
      }

      const pipeline = [];
      if (Object.keys(match).length) pipeline.push({ $match: match });
      pipeline.push({ $sample: { size: Math.max(1, Math.min(50, count)) } });

      let docs = [];
      try {
        docs = await Question.aggregate(pipeline).allowDiskUse(true);
      } catch (e) {
        console.error("[/api/lms/quiz] aggregate error (sampling):", e && (e.stack || e));
      }

      if (!docs || !docs.length) {
        // fallback to file questions
        const fallback = fetchRandomQuestionsFromFile(count);
        const series = fallback.map(d => ({ id: d.id, text: d.text, choices: d.choices, tags: d.tags, difficulty: d.difficulty }));
        return res.json({ examId: null, series });
      }

      // For sampling we will attempt to include children for any comprehension found,
      // but we do not expand parent markers because sampling returns question docs directly.
      const outSeries = [];
      for (const d of docs) {
        const isComp = (d && d.type === "comprehension");
        if (isComp) {
          // try to fetch children (best effort) and preserve order
          let children = [];
          try {
            const cids = Array.isArray(d.questionIds) ? d.questionIds.map(String) : [];
            if (cids.length) {
              const objIds = cids.filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
              if (objIds.length) {
                const cs = await Question.find({ _id: { $in: objIds } }).lean().exec();
                children = cids.map(cid => {
                  const f = cs.find(x => String(x._id) === String(cid));
                  if (!f) return null;
                  // apply default (identity) choicesOrder for sampled children
                  const origChoices = (f.choices || []).map(ch => (typeof ch === 'string' ? { text: ch } : { text: ch.text || '' }));
                  const displayed = origChoices.map(c => c);
                  const choicesOrder = Array.from({ length: displayed.length }, (_, i) => i);
                  return {
                    id: String(f._id),
                    text: f.text,
                    choices: displayed,
                    choicesOrder,
                    tags: f.tags || [],
                    difficulty: f.difficulty || 'medium'
                  };
                }).filter(Boolean);
              }
            }
          } catch (e) {
            console.warn("[/api/lms/quiz] failed to load children for sampled parent:", d._id, e && e.message);
          }

          outSeries.push({ id: String(d._id), type: "comprehension", passage: d.passage || d.text || "", children, tags: d.tags || [], difficulty: d.difficulty || 'medium' });
        } else {
          const origChoices = (d.choices || []).map(c => (typeof c === 'string' ? { text: c } : { text: c.text || '' }));
          const choicesOrder = Array.from({ length: origChoices.length }, (_, i) => i);
          outSeries.push({
            id: String(d._id),
            text: d.text,
            choices: origChoices,
            choicesOrder,
            tags: d.tags || [],
            difficulty: d.difficulty || 'medium'
          });
        }
      }

      return res.json({ examId: null, series: outSeries });
    } catch (e) {
      console.error("[/api/lms/quiz] sampling error:", e && (e.stack || e));
      return res.status(500).json({ error: "failed to sample questions" });
    }
  } catch (err) {
    console.error("[GET /api/lms/quiz] unexpected error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

/**
 * Helper: ensure certificates directory exists and return folder path
 */
async function ensureCertificatesDir() {
  const base = path.join(process.cwd(), "public", "docs", "certificates");
  try { await fs.promises.mkdir(base, { recursive: true }); } catch (e) {}
  return base;
}

/**
 * Helper: generate certificate HTML given details
 * World-class luxury design - navy + gold, Cinzel + Cormorant Garamond
 */
function buildCertificateHtml({
  name,
  orgName,
  moduleName,
  quizTitle,
  score,
  percentage,
  date,
}) {
  const esc = (s) =>
    s == null
      ? ""
      : String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

  const dateStr = date
    ? new Date(date).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const moduleTitle = esc(quizTitle || moduleName || "Module");
  const recipientName = esc(name || "Recipient");
  const institution = esc(orgName || "CRIPFCnt Institute");
  const scoreDisplay = esc(score != null ? String(score) : "-");
  const pctDisplay = esc(percentage != null ? String(percentage) : "-");

  /* ── brand config by org ── */
  const orgLow = (orgName || "").toLowerCase();
  let brand = {
    primary: "#0a1628",
    accent:  "#b8973a",
    accent2: "#c9a84c",
    cream:   "#fdf8ee",
    series:  "CRIPFCnt Learning Management System",
  };

  if (/nyaradzo/.test(orgLow)) {
    brand = { ...brand, primary: "#0a2e5c", accent: "#c9a227", accent2: "#dbb84a", series: "Nyaradzo Group Training" };
  } else if (/winchester/.test(orgLow)) {
    brand = { ...brand, primary: "#1F3C88", accent: "#8B1E2D", accent2: "#a83040", series: "Winchester School" };
  } else if (/st[\s-]?eurit|eurit/.test(orgLow)) {
    brand = { ...brand, primary: "#111111", accent: "#D4AF37", accent2: "#e8c95a", series: "St Eurit International School" };
  }

  /* ── short certificate ID ── */
  const certId = `CERT-${dateStr.replace(/-/g, "")}-${(name || "X")
    .replace(/\s+/g, "")
    .toUpperCase()
    .slice(0, 6)
    .padEnd(6, "0")}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Certificate of Completion</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Cinzel:wght@400;600;700&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
@page { margin: 0; size: A4; }

html, body {
  width: 210mm;
  height: 297mm;
  overflow: hidden;
  background: ${brand.primary};
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Cormorant Garamond', Georgia, serif;
}

.frame-outer {
  width: 190mm;
  min-height: 277mm;
  background: ${brand.cream};
  padding: 5px;
  position: relative;
}

.frame-border-1 {
  border: 2.5px solid ${brand.accent};
  padding: 6px;
  position: relative;
  min-height: calc(277mm - 10px);
}

.frame-border-2 {
  border: 1px solid ${brand.accent};
  padding: 32px 44px 36px;
  position: relative;
  min-height: calc(277mm - 22px);
  background: ${brand.cream};
  display: flex;
  flex-direction: column;
  align-items: center;
}

.watermark {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-30deg);
  font-family: 'Cinzel', serif;
  font-size: 80px;
  font-weight: 700;
  color: ${brand.accent};
  opacity: 0.04;
  white-space: nowrap;
  letter-spacing: 10px;
  pointer-events: none;
  text-transform: uppercase;
  z-index: 0;
}

.corner {
  position: absolute;
  width: 52px;
  height: 52px;
  z-index: 2;
}
.corner svg { width: 100%; height: 100%; }
.corner.tl { top: -2px; left: -2px; }
.corner.tr { top: -2px; right: -2px; transform: scaleX(-1); }
.corner.bl { bottom: -2px; left: -2px; transform: scaleY(-1); }
.corner.br { bottom: -2px; right: -2px; transform: scale(-1); }

.cert-content {
  position: relative;
  z-index: 1;
  width: 100%;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
}

.org-badge {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  background: ${brand.primary};
  color: ${brand.accent2};
  padding: 5px 22px 5px 16px;
  font-family: 'Cinzel', serif;
  font-size: 8px;
  letter-spacing: 3.5px;
  text-transform: uppercase;
  margin-bottom: 20px;
}
.org-badge .dot {
  width: 6px; height: 6px;
  background: ${brand.accent};
  border-radius: 50%;
  flex-shrink: 0;
}

.cert-title {
  font-family: 'Cinzel', serif;
  font-size: 36px;
  font-weight: 700;
  color: ${brand.primary};
  letter-spacing: 4px;
  text-transform: uppercase;
  line-height: 1.05;
  margin-bottom: 5px;
}

.cert-subtitle {
  font-family: 'Cormorant Garamond', serif;
  font-size: 16px;
  font-style: italic;
  color: #7a6a3a;
  letter-spacing: 2px;
  margin-bottom: 18px;
}

.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 320px;
  margin-bottom: 20px;
}
.divider-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, ${brand.accent} 40%, ${brand.accent} 60%, transparent);
}

.certifies {
  font-family: 'Cormorant Garamond', serif;
  font-size: 13px;
  color: #7a6040;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.recipient-name {
  font-family: 'Cormorant Garamond', serif;
  font-size: 46px;
  font-weight: 600;
  font-style: italic;
  color: ${brand.primary};
  line-height: 1.1;
  letter-spacing: 1px;
  margin-bottom: 16px;
  max-width: 480px;
  word-break: break-word;
}

.completed-text {
  font-family: 'Cormorant Garamond', serif;
  font-size: 13px;
  color: #7a6040;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  margin-bottom: 14px;
}

.module-box {
  background: ${brand.primary};
  padding: 14px 30px 16px;
  width: 90%;
  max-width: 480px;
  margin-bottom: 22px;
  position: relative;
}
.module-box::before,
.module-box::after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, ${brand.accent} 20%, ${brand.accent} 80%, transparent);
}
.module-box::before { top: 0; }
.module-box::after  { bottom: 0; }

.module-series {
  font-family: 'Cinzel', serif;
  font-size: 7.5px;
  letter-spacing: 4px;
  color: ${brand.accent};
  text-transform: uppercase;
  margin-bottom: 7px;
}

.module-title {
  font-family: 'Cinzel', serif;
  font-size: 11.5px;
  font-weight: 600;
  color: ${brand.cream};
  letter-spacing: 1.5px;
  line-height: 1.6;
  text-transform: uppercase;
}

.stats {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 26px;
  width: 80%;
  max-width: 420px;
}

.stat { flex: 1; text-align: center; }

.stat-value {
  font-family: 'Cinzel', serif;
  font-size: 22px;
  font-weight: 700;
  color: ${brand.primary};
  line-height: 1;
  margin-bottom: 5px;
}
.stat-value.gold { color: ${brand.accent}; }

.stat-label {
  font-family: 'Cormorant Garamond', serif;
  font-size: 10px;
  color: #7a6040;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.stat-sep {
  width: 1px;
  height: 40px;
  background: linear-gradient(180deg, transparent, ${brand.accent} 30%, ${brand.accent} 70%, transparent);
}

.cert-bottom {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  width: 100%;
  margin-top: auto;
  padding-top: 18px;
  border-top: 1px solid #d4c89a;
}

.sig { flex: 1; text-align: center; }

.sig-script {
  font-family: 'Cormorant Garamond', serif;
  font-size: 24px;
  font-style: italic;
  color: ${brand.primary};
  margin-bottom: 4px;
  line-height: 1;
}

.sig-line {
  width: 130px;
  height: 1px;
  background: ${brand.primary};
  margin: 0 auto 5px;
}

.sig-name {
  font-family: 'Cinzel', serif;
  font-size: 8px;
  letter-spacing: 2px;
  color: ${brand.primary};
  text-transform: uppercase;
  margin-bottom: 2px;
}

.sig-role {
  font-family: 'Cormorant Garamond', serif;
  font-size: 10px;
  font-style: italic;
  color: #7a6040;
}

.seal {
  flex-shrink: 0;
  width: 80px;
  height: 80px;
  margin: 0 12px;
}
.seal svg { width: 100%; height: 100%; }

.cert-id {
  font-family: 'Cormorant Garamond', serif;
  font-size: 9px;
  color: #aaa090;
  letter-spacing: 1.2px;
  text-align: center;
  margin-top: 12px;
  width: 100%;
}
</style>
</head>
<body>

<div class="frame-outer">
  <div class="frame-border-1">

    <div class="corner tl">
      <svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 50V7C2 4.2 4.2 2 7 2H50" stroke="${brand.accent}" stroke-width="1.5"/>
        <path d="M2 30V7C2 4.2 4.2 2 7 2H30" stroke="${brand.accent2}" stroke-width="0.5"/>
        <circle cx="7" cy="7" r="3" fill="${brand.accent}"/>
        <circle cx="2" cy="2" r="1.8" fill="${brand.accent2}"/>
        <path d="M13 2H18M2 13V18" stroke="${brand.accent}" stroke-width="0.8"/>
      </svg>
    </div>
    <div class="corner tr">
      <svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 50V7C2 4.2 4.2 2 7 2H50" stroke="${brand.accent}" stroke-width="1.5"/>
        <path d="M2 30V7C2 4.2 4.2 2 7 2H30" stroke="${brand.accent2}" stroke-width="0.5"/>
        <circle cx="7" cy="7" r="3" fill="${brand.accent}"/>
        <circle cx="2" cy="2" r="1.8" fill="${brand.accent2}"/>
        <path d="M13 2H18M2 13V18" stroke="${brand.accent}" stroke-width="0.8"/>
      </svg>
    </div>
    <div class="corner bl">
      <svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 50V7C2 4.2 4.2 2 7 2H50" stroke="${brand.accent}" stroke-width="1.5"/>
        <path d="M2 30V7C2 4.2 4.2 2 7 2H30" stroke="${brand.accent2}" stroke-width="0.5"/>
        <circle cx="7" cy="7" r="3" fill="${brand.accent}"/>
        <circle cx="2" cy="2" r="1.8" fill="${brand.accent2}"/>
        <path d="M13 2H18M2 13V18" stroke="${brand.accent}" stroke-width="0.8"/>
      </svg>
    </div>
    <div class="corner br">
      <svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 50V7C2 4.2 4.2 2 7 2H50" stroke="${brand.accent}" stroke-width="1.5"/>
        <path d="M2 30V7C2 4.2 4.2 2 7 2H30" stroke="${brand.accent2}" stroke-width="0.5"/>
        <circle cx="7" cy="7" r="3" fill="${brand.accent}"/>
        <circle cx="2" cy="2" r="1.8" fill="${brand.accent2}"/>
        <path d="M13 2H18M2 13V18" stroke="${brand.accent}" stroke-width="0.8"/>
      </svg>
    </div>

    <div class="frame-border-2">
      <div class="watermark">CRIPFCNT</div>

      <div class="cert-content">

        <div class="org-badge">
          <span class="dot"></span>
          ${brand.series}
          <span class="dot"></span>
        </div>

        <h1 class="cert-title">Certificate</h1>
        <p class="cert-subtitle">of Completion</p>

        <div class="divider">
          <div class="divider-line"></div>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6L12 2z"
                  fill="${brand.accent}"/>
          </svg>
          <div class="divider-line"></div>
        </div>

        <p class="certifies">This Certifies That</p>

        <h2 class="recipient-name">${recipientName}</h2>

        <p class="completed-text">Has Successfully Completed the Module</p>

        <div class="module-box">
          <p class="module-series">${institution} &nbsp;&middot;&nbsp; Official Record</p>
          <p class="module-title">${moduleTitle}</p>
        </div>

        <div class="stats">
          <div class="stat">
            <div class="stat-value">${scoreDisplay}</div>
            <div class="stat-label">Final Score</div>
          </div>
          <div class="stat-sep"></div>
          <div class="stat">
            <div class="stat-value gold">${pctDisplay}%</div>
            <div class="stat-label">Distinction</div>
          </div>
          <div class="stat-sep"></div>
          <div class="stat">
            <div class="stat-value">${dateStr}</div>
            <div class="stat-label">Date Awarded</div>
          </div>
        </div>

        <div class="cert-bottom">
          <div class="sig">
            <div class="sig-script">Director</div>
            <div class="sig-line"></div>
            <div class="sig-name">Director of Learning</div>
            <div class="sig-role">${institution}</div>
          </div>

          <div class="seal">
            <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="40" cy="40" r="37" fill="${brand.primary}" stroke="${brand.accent}" stroke-width="1.5"/>
              <circle cx="40" cy="40" r="32" fill="none" stroke="${brand.accent2}" stroke-width="0.5"/>
              <circle cx="40" cy="40" r="27" fill="none" stroke="${brand.accent}" stroke-width="0.5" stroke-dasharray="2.5 2"/>
              <path d="M40 16l2.8 8.5H51l-7 5.2 2.7 8.5L40 33l-6.7 5.2 2.7-8.5-7-5.2h8.2L40 16z"
                    fill="${brand.accent2}"/>
              <text x="40" y="52" text-anchor="middle"
                    font-family="'Cinzel', serif" font-size="6.5" font-weight="600"
                    fill="${brand.accent2}" letter-spacing="2">CRIPFCNT</text>
              <text x="40" y="60" text-anchor="middle"
                    font-family="'Cinzel', serif" font-size="5"
                    fill="${brand.accent}" letter-spacing="1.5">VERIFIED</text>
              <circle cx="40" cy="65" r="2" fill="${brand.accent}" opacity="0.7"/>
            </svg>
          </div>

          <div class="sig">
            <div class="sig-script">Academic</div>
            <div class="sig-line"></div>
            <div class="sig-name">Chief Academic Officer</div>
            <div class="sig-role">${institution}</div>
          </div>
        </div>

        <p class="cert-id">
          Certificate ID: ${certId}
          &nbsp;&middot;&nbsp;
          Awarded by ${institution}
        </p>

      </div>
    </div>
  </div>
</div>

</body>
</html>`;
}



/**
 * Try to generate certificate PDF using Puppeteer (if available) otherwise fallback to pdfkit.
 * Returns { filepath, filename, method }
 */
async function generateCertificatePdf({ name, orgName, moduleName,quizTitle,  score, percentage, date, req }) {
  const certsDir = await ensureCertificatesDir();
  const filename = `certificate-${Date.now().toString(36)}.pdf`;
  const filepath = path.join(certsDir, filename);

  // First try Puppeteer (dynamic import)
  try {
    let puppeteer = null;
    try {
      puppeteer = (await import("puppeteer")).default || (await import("puppeteer"));
    } catch (e) {
      try { puppeteer = (await import("puppeteer-core")).default || (await import("puppeteer-core")); } catch (e2) { puppeteer = null; }
    }

    if (puppeteer) {
      const launchOpts = { args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] };
      if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      if (process.env.PUPPETEER_LAUNCH_OPTS) {
        try { Object.assign(launchOpts, JSON.parse(process.env.PUPPETEER_LAUNCH_OPTS)); } catch (e) {}
      }

      const browser = await puppeteer.launch(launchOpts);
      try {
        const page = await browser.newPage();
        const html = buildCertificateHtml({ name, orgName, moduleName,quizTitle, score, percentage, date });
        await page.setContent(html, { waitUntil: "networkidle0", timeout: 45000 });
        // Give Google Fonts an extra moment to fully render before capture
        await new Promise((r) => setTimeout(r, 1200));
        await page.emulateMediaType("screen");
        await page.pdf({ path: filepath, format: "A4", printBackground: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
        return { filepath, filename, method: "puppeteer" };
      } finally {
        try { await browser.close(); } catch (e) {}
      }
    }
  } catch (err) {
    console.warn("generateCertificatePdf: puppeteer failed or not available, falling back to pdfkit:", err && (err.stack || err.message || err));
  }

  // Fallback to pdfkit (dynamic import/require)
  try {
    let PDFDocument = null;
    try {
      PDFDocument = (await import("pdfkit")).default || (await import("pdfkit"));
    } catch (e) {
      try { PDFDocument = require("pdfkit"); } catch (er) { PDFDocument = null; }
    }

    if (!PDFDocument) throw new Error("pdfkit not available");

    return await new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const stream = fs.createWriteStream(filepath);
        doc.pipe(stream);

        // Simple certificate layout
        doc.fontSize(10).fillColor("#666").text(orgName || "", { align: "center" });
        doc.moveDown(1.2);
        doc.fontSize(24).fillColor("#111").text("Certificate of Completion", { align: "center" });
        doc.moveDown(1.2);
        doc.fontSize(12).fillColor("#444").text("This certifies that", { align: "center" });
        doc.moveDown(0.8);
        doc.fontSize(20).fillColor("#000").text(name || "Recipient", { align: "center", underline: false });
        doc.moveDown(0.8);
        doc.fontSize(12).fillColor("#444").text(`has successfully completed the module`, { align: "center" });
        doc.moveDown(0.6);
        doc.fontSize(14).fillColor("#000").text(quizTitle || "", { align: "center" });
        doc.moveDown(1.2);

        doc.fontSize(11).fillColor("#333").text(`Score: ${score || 0}`, { align: "center" });
        doc.moveDown(0.4);
        doc.fontSize(11).fillColor("#333").text(`Percentage: ${percentage || 0}%`, { align: "center" });
        doc.moveDown(1.2);
        doc.fontSize(10).fillColor("#666").text(`Date: ${date ? (new Date(date)).toISOString().slice(0,10) : (new Date()).toISOString().slice(0,10)}`, { align: "center" });

        doc.end();
        stream.on("finish", () => resolve({ filepath, filename, method: "pdfkit" }));
        stream.on("error", (err) => reject(err));
      } catch (err) { reject(err); }
    });
  } catch (err) {
    console.warn("generateCertificatePdf: pdfkit fallback failed:", err && (err.stack || err.message || err));
    return null;
  }
}

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [{ questionId, choiceIndex }] }
 */
router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const quizTitleFromClient =
  typeof payload.quizTitle === "string" && payload.quizTitle.trim()
    ? payload.quizTitle.trim()
    : null;

    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    
    if (!answers.length) return res.status(400).json({ error: "No answers submitted" });

    const examId = String(payload.examId || "").trim() || null;
    const moduleKey = String(payload.module || "").trim() || null;
    const orgSlugOrId = payload.org || null;

    // 🔑 SINGLE SOURCE OF TRUTH FOR examId (used by BOTH certificate & attempt)



    // map of question ids supplied
    const qIds = answers.map(a => a.questionId).filter(Boolean).map(String);

    // try to load ExamInstance (may be null)
    let exam = null;
    if (examId) {
      try {
        exam = await ExamInstance.findOne({ examId }).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] exam lookup error:", e && (e.stack || e));
      }
    }



    // ✅ STEP 13: HANDLE AI QUIZ SUBMISSION
if (exam?.meta?.isAIGenerated && exam?.meta?.aiQuizId) {
  console.log("[AI Quiz Submit] Processing AI-generated quiz answers");
  
  try {
    const AIQuiz = (await import("../models/aiQuiz.js")).default;
    const aiQuiz = await AIQuiz.findById(exam.meta.aiQuizId).lean();
    
    if (!aiQuiz || !Array.isArray(aiQuiz.questions)) {
      throw new Error("AI Quiz not found or has no questions");
    }

    // Create answer key from AI quiz
    const aiAnswerKey = {};
    aiQuiz.questions.forEach((q, idx) => {
      aiAnswerKey[`ai:${aiQuiz._id}:${idx}`] = {
        correctIndex: q.correctIndex,
        explanation: q.explanation
      };
    });

    // Score AI quiz
    let aiScore = 0;
    const aiDetails = [];
    const aiSavedAnswers = [];

    for (const a of answers) {
      const qid = String(a.questionId || "");
      const answer = aiAnswerKey[qid];
      
      if (answer) {
        const correct = answer.correctIndex === a.choiceIndex;
        if (correct) aiScore++;

        aiDetails.push({
          questionId: qid,
          correctIndex: answer.correctIndex,
          yourIndex: a.choiceIndex,
          correct,
          explanation: answer.explanation
        });

        aiSavedAnswers.push({
          questionId: qid,
          answerType: "mcq",
          choiceIndex: a.choiceIndex,
          correctIndex: answer.correctIndex,
          correct
        });
      }
    }

    const aiTotal = aiQuiz.questions.length;
    const aiPercentage = Math.round((aiScore / Math.max(1, aiTotal)) * 100);
    const passThreshold = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);
    const aiPassed = aiPercentage >= passThreshold;

    // Resolve final exam ID
    const finalExamId = exam?.examId || examId || ("exam-" + Date.now().toString(36));
    const attemptUserId = exam?.userId || req.user?._id;

    if (!attemptUserId) {
      throw new Error("Attempt userId could not be resolved");
    }

    // Find existing attempt
    let attempt = await Attempt.findOne({
      examId: finalExamId,
      userId: attemptUserId
    }).sort({ createdAt: -1 }).exec();

    const now = new Date();

    // Calculate duration
    let duration = {
      hours: 0,
      minutes: 0,
      seconds: 0,
      totalSeconds: 0
    };

    if (attempt?.startedAt) {
      const wallClockSeconds = Math.floor(
        (now.getTime() - new Date(attempt.startedAt).getTime()) / 1000
      );

      const cappedSeconds = exam?.durationMinutes
        ? Math.min(wallClockSeconds, exam.durationMinutes * 60)
        : Math.max(0, wallClockSeconds);

      duration = {
        hours: Math.floor(cappedSeconds / 3600),
        minutes: Math.floor((cappedSeconds % 3600) / 60),
        seconds: cappedSeconds % 60,
        totalSeconds: cappedSeconds
      };
    }

  // Create/update attempt
    // ✅ FIX: Resolve org from student if exam.org is missing
    let attemptOrgId = exam?.org || null;
    if (!attemptOrgId) {
      const studentForOrg = await User.findById(attemptUserId).select("organization").lean();
      attemptOrgId = studentForOrg?.organization || null;
    }

    const attemptDoc = {
      examId: finalExamId,
      userId: attemptUserId,
      organization: attemptOrgId,
      module: exam?.module || aiQuiz.subject || null,
      questionIds: answers.map(a => a.questionId),
      answers: aiSavedAnswers,
      score: aiScore,
      maxScore: aiTotal,
      passed: aiPassed,
      status: "finished",
      quizTitle: aiQuiz.title,
      duration,
      startedAt: attempt?.startedAt || now,
      finishedAt: now,
      meta: {
        isAIGenerated: true,
        aiQuizId: exam.meta.aiQuizId,
        difficulty: aiQuiz.difficulty
      }
    };

    let savedAttempt = null;
    if (attempt) {
      await Attempt.updateOne({ _id: attempt._id }, { $set: attemptDoc }).exec();
      savedAttempt = await Attempt.findById(attempt._id).lean().exec();
    } else {
      const newA = await Attempt.create(attemptDoc);
      savedAttempt = await Attempt.findById(newA._id).lean().exec();
    }


    // 🏆 BATTLE RESULT RECORD (AI submit branch)
if (exam?.meta?.isBattle && exam?.meta?.battleId) {
  const timeTakenSec = duration?.totalSeconds ?? null;

  await recordBattleResultFromExam({
    exam,
    userId: attemptUserId,
    examId: finalExamId,
    percentage: aiPercentage,
    score: aiScore,
    maxScore: aiTotal,
    timeTakenSec
  });
}




    // Save certificate if passed
    let savedCertificate = null;
    if (aiPassed) {
      const serial = "CERT-" + Date.now().toString(36).toUpperCase() + "-" + 
                     Math.random().toString(36).slice(2, 6).toUpperCase();

     // ✅ FIX: Resolve org from student if exam.org is missing
let aiOrgId = exam?.org || null;
if (!aiOrgId) {
  const studentDoc = await User.findById(attemptUserId).select("organization").lean();
  aiOrgId = studentDoc?.organization || null;
}

savedCertificate = await Certificate.create({
  userId: attemptUserId,
  orgId: aiOrgId,
  examId: finalExamId,
  quizTitle: aiQuiz.title,
  moduleName: exam?.module || aiQuiz.subject || null,
  courseTitle: exam?.module || aiQuiz.subject || "AI Quiz",
  score: aiScore,
  percentage: aiPercentage,
  serial
});
    }

    // Generate certificate PDF if passed
    let certificateUrl = null;
    if (aiPassed && savedCertificate) {
      try {
        // Get student name
        let recipientName = "Learner";
        const fullUser = await User.findById(attemptUserId)
          .select("firstName lastName displayName")
          .lean();

        if (fullUser) {
          if (fullUser.displayName?.trim()) {
            recipientName = fullUser.displayName.trim();
          } else if (fullUser.firstName || fullUser.lastName) {
            recipientName = [fullUser.firstName || "", fullUser.lastName || ""].join(" ").trim();
          }
        }

        // Get org name
        let orgName = "";
        if (exam?.org) {
          const orgObj = await Organization.findById(exam.org).lean();
          if (orgObj) orgName = orgObj.name || orgObj.title || "";
        }

        const certResult = await generateCertificatePdf({
          name: recipientName,
          orgName,
          quizTitle: aiQuiz.title,
          moduleName: exam?.module || null,
          score: aiScore,
          percentage: aiPercentage,
          date: now,
          req
        });

        if (certResult?.filename) {
          const site = (process.env.SITE_URL || "").replace(/\/$/, "");
          const baseForMedia = site || `${req.protocol}://${req.get("host")}`;
          certificateUrl = `${baseForMedia}/docs/certificates/${certResult.filename}`;
        }
      } catch (certErr) {
        console.error("[AI Quiz] Certificate generation failed:", certErr);
      }
    }


    // ✅ FIX: Update topic mastery for AI quizzes too
if (savedAttempt && savedAttempt._id) {
  updateTopicMasteryFromAttempt(savedAttempt._id)
    .then(result => {
      console.log(`[AI Quiz] Topic mastery updated:`, result);
    })
    .catch(err => {
      console.error("[AI Quiz] Failed to update topic mastery:", err);
    });
}
    // Return AI quiz results
  const battlePayload =
  (exam?.meta?.isBattle && exam?.meta?.battleId)
    ? {
        battleId: String(exam.meta.battleId),
        resultsUrl: `/arena/results?battleId=${encodeURIComponent(String(exam.meta.battleId))}`
      }
    : null;

return res.json({
  examId: finalExamId,
  total: aiTotal,
  score: aiScore,
  percentage: aiPercentage,
  passThreshold,
  passed: aiPassed,
  details: aiDetails,
  certificateUrl,
  isAIGenerated: true,
  battle: battlePayload,
  debug: {
    examFound: !!exam,
    attemptSaved: !!savedAttempt,
    aiQuizId: exam.meta.aiQuizId
  }
});

  } catch (aiError) {
    console.error("[AI Quiz Submit] Error:", aiError);
    return res.status(500).json({
      error: "Failed to score AI quiz",
      detail: aiError.message
    });
  }
}
// END OF AI QUIZ SUBMIT HANDLING
    // ⛔ QUIZ EXPIRY ENFORCEMENT (SERVER-SIDE - SOURCE OF TRUTH)
// ⛔ CALENDAR-BASED EXPIRY ONLY
if (process.env.QUIZ_EXPIRY_ENABLED === "true" && exam?.expiresAt) {
  if (new Date() > new Date(exam.expiresAt)) {
    return res.status(403).json({
      error: "Quiz expired",
      expiredAt: exam.expiresAt
    });
  }
}


// 🔑 ALWAYS SAVE ATTEMPT AGAINST STUDENT (NOT PARENT)
// ✅ SAFE EXAM ID RESOLUTION
let finalExamId;
if (exam?.examId) finalExamId = exam.examId;
else if (examId) finalExamId = examId;
else finalExamId = "exam-" + Date.now().toString(36);

// ✅ Resolve student (quiz taker) ONCE, early
// ✅ FIXED - quiz taker (req.user) always wins
const attemptUserId =
  req.user?._id ||     // person who is logged in and submitted the quiz
  payload.userId ||    // explicit userId sent in the submit payload
  exam?.learnerId ||   // learner field if explicitly set
  exam?.userId ||      // fallback: only used when no session (e.g. anonymous/kiosk)
  null;

if (!attemptUserId) {
  throw new Error("Attempt userId (student) could not be resolved");
}

    // 🔑 SINGLE SOURCE OF TRUTH - AFTER exam is known
// ✅ SAFE EXAM ID RESOLUTION
//let finalExamId;


  console.log("EXAM ALIGNMENT CHECK:", {
  payloadExamId: examId,
  finalExamId,
  examFound: !!exam
});

    // load DB questions for any ObjectId-like ids (use Question model)
    const byId = {};
    const dbIds = qIds.filter(id => mongoose.isValidObjectId(id));
    if (dbIds.length) {
      try {
        const qDocs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of qDocs) byId[String(q._id)] = q;
      } catch (e) {
        console.error("[quiz/submit] DB lookup error:", e && (e.stack || e));
      }
    }

    // file fallback: include file questions by id (for fid-... items)
    try {
      const p = path.join(process.cwd(), "data", "data_questions.json");
      if (fs.existsSync(p)) {
        const fileQ = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const fq of fileQ) {
          const fid = String(fq.id || fq._id || fq.uuid || "");
          if (fid && !byId[fid]) byId[fid] = fq;
        }
      }
    } catch (e) {
      console.error("[quiz/submit] file fallback error:", e && (e.stack || e));
    }


    // ✅ AI ANSWER KEY for ai:<quizId>:<idx> (battle + mixed exams)
const aiAnswerKey = {}; // token -> { correctIndex, choices }
try {
  const aiTokens = qIds.filter(id => String(id).startsWith("ai:"));
  const groups = {}; // quizId -> Set(indices)

  for (const tok of aiTokens) {
    const parts = String(tok).split(":");
    const quizId = parts[1];
    const idx = Number(parts[2]);
    if (!quizId || !Number.isFinite(idx)) continue;
    if (!groups[quizId]) groups[quizId] = new Set();
    groups[quizId].add(idx);
  }

  const quizIds = Object.keys(groups).filter(id => mongoose.isValidObjectId(id));
  if (quizIds.length) {
    const AIQuiz = (await import("../models/aiQuiz.js")).default;
    const quizzes = await AIQuiz.find({ _id: { $in: quizIds } })
      .select("_id questions")
      .lean();

    for (const aq of quizzes) {
      const set = groups[String(aq._id)];
      if (!set) continue;

      for (const idx of Array.from(set)) {
        const q = aq?.questions?.[idx];
        if (!q) continue;

        aiAnswerKey[`ai:${aq._id}:${idx}`] = {
          correctIndex: (typeof q.correctIndex === "number") ? q.correctIndex : null,
          choices: Array.isArray(q.choices) ? q.choices : []
        };
      }
    }
  }
} catch (e) {
  console.warn("[quiz/submit] aiAnswerKey build failed:", e?.message);
}
    // Build a quick lookup for exam question order & choicesOrder if exam exists
    const examIndexMap = {}; // questionId -> index in exam.questionIds
    const examChoicesOrder = Array.isArray(exam && exam.choicesOrder) ? exam.choicesOrder : [];

    if (exam && Array.isArray(exam.questionIds)) {
      for (let i = 0; i < exam.questionIds.length; i++) {
        const qidStr = String(exam.questionIds[i]);
        examIndexMap[qidStr] = i;
      }
    }

    // Scoring & saved answers
   // Scoring & saved answers
let score = 0;
let maxScore = 0; // ✅ FIX: real max score (MCQs only)
const details = [];
const savedAnswers = [];


for (const a of answers) {
  const qid = String(a.questionId || "");
  const qdoc = byId[qid] || null;

  const qObjId = mongoose.isValidObjectId(qid)
    ? mongoose.Types.ObjectId(qid)
    : qid;

  /* ===============================
     📝 ESSAY QUESTION HANDLING
  =============================== */
  if (qdoc?.answerType === "essay") {
    const selections = a.essaySelections || {};

    const essayText = qdoc.essayTemplate
      ? qdoc.essayTemplate.replace(
          /\{(\w+)\}/g,
          (_, key) => selections[key] || ""
        )
      : "";

    savedAnswers.push({
      questionId: qObjId,
      answerType: "essay",
      essaySelections: selections,
      essayText
    });

    // ❗ essays are NOT auto-marked
    continue;
  }

  /* ===============================
     ✅ MCQ HANDLING (UNCHANGED LOGIC)
  =============================== */
  const shownIndex =
    typeof a.choiceIndex === "number" ? a.choiceIndex : null;

  let canonicalIndex =
    typeof shownIndex === "number" ? shownIndex : null;

  // per-question mapping
  if (qdoc && Array.isArray(qdoc.choicesOrder) && typeof shownIndex === "number") {
    const map = qdoc.choicesOrder;
    if (typeof map[shownIndex] === "number") {
      canonicalIndex = map[shownIndex];
    } else {
      for (let orig = 0; orig < map.length; orig++) {
        if (map[orig] === shownIndex) {
          canonicalIndex = orig;
          break;
        }
      }
    }
  }
  // fallback to exam-level mapping
  else if (exam && examIndexMap.hasOwnProperty(qid)) {
    const qPos = examIndexMap[qid];
    const mapping = Array.isArray(examChoicesOrder[qPos])
      ? examChoicesOrder[qPos]
      : null;

    if (mapping && typeof shownIndex === "number") {
      let mapped = mapping[shownIndex];
      if (typeof mapped === "number") {
        canonicalIndex = mapped;
      } else {
        for (let orig = 0; orig < mapping.length; orig++) {
          if (mapping[orig] === shownIndex) {
            canonicalIndex = orig;
            break;
          }
        }
      }
    }
  }

 let correctIndex = null;

if (qdoc) {
  if (typeof qdoc.correctIndex === "number") correctIndex = qdoc.correctIndex;
  else if (typeof qdoc.answerIndex === "number") correctIndex = qdoc.answerIndex;
  else if (typeof qdoc.correct === "number") correctIndex = qdoc.correct;
} else if (aiAnswerKey[qid]) {
  correctIndex = aiAnswerKey[qid].correctIndex;
}

  let selectedText = "";
if (qdoc) {
  const choices = qdoc.choices || [];
  const c = choices[canonicalIndex];
  selectedText = typeof c === "string" ? c : (c?.text || "");
} else if (aiAnswerKey[qid]) {
  const choices = aiAnswerKey[qid].choices || [];
  const c = choices[canonicalIndex];
  selectedText = typeof c === "string" ? c : (c?.text || "");
}
  const correct =
    correctIndex !== null &&
    canonicalIndex !== null &&
    correctIndex === canonicalIndex;

 maxScore++;           // ✅ count this question
if (correct) score++;


  details.push({
    questionId: qid,
    correctIndex,
    yourIndex: canonicalIndex,
    correct
  });

  savedAnswers.push({
    questionId: qObjId,
    answerType: "mcq",
    choiceIndex: canonicalIndex,
    shownIndex,
    selectedText,
    correctIndex,
    correct
  });
}


   const total = maxScore; // ✅ FIX
const percentage = Math.round((score / Math.max(1, maxScore)) * 100);

    const passThreshold = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);
    const passed = percentage >= passThreshold;


    // 🔑 RESOLVE REAL QUIZ TITLE FROM PARENT QUESTION
let resolvedQuizTitle =
  (typeof exam?.quizTitle === "string" && exam.quizTitle.trim()) ? exam.quizTitle.trim()
  : (typeof exam?.title === "string" && exam.title.trim()) ? exam.title.trim()
  : (typeof quizTitleFromClient === "string" && quizTitleFromClient.trim()) ? quizTitleFromClient.trim()
  : null;

try {
  const parentToken = (exam?.questionIds || []).find(
    q => typeof q === "string" && q.startsWith("parent:")
  );

  if (parentToken) {
    const parentId = parentToken.split(":")[1];

    if (mongoose.isValidObjectId(parentId)) {
      const parentQuestion = await Question.findById(parentId)
        .select("text")
        .lean();

      if (parentQuestion?.text) {
        resolvedQuizTitle = parentQuestion.text.trim();
      }
    }
  }
} catch (e) {
  console.warn("[attempt] failed to resolve quiz title", e.message);
}

    // ===============================
// 🎓 SAVE CERTIFICATE (NO PDF)
// ===============================
let savedCertificate = null;

if (passed) {
  try {
    // generate readable but unique serial
    const serial =
      "CERT-" +
      Date.now().toString(36).toUpperCase() +
      "-" +
      Math.random().toString(36).slice(2, 6).toUpperCase();

   /* savedCertificate = await Certificate.create({
      userId: (req.user && req.user._id)
        ? req.user._id
        : (exam && exam.user) || null,

      orgId: (exam && exam.org) || null,
      examId: examId || ("exam-" + Date.now().toString(36)),

      courseTitle: (exam && exam.module)
        ? exam.module
        : (moduleKey || "Quiz"),

      score,
      percentage,
      serial,
    });*/

   // 🔑 FORCE certificate + attempt to share SAME examId




savedCertificate = await Certificate.create({
  //userId: exam?.userId || attempt?.userId,
  // ✅ always student / quiz taker
userId: attemptUserId,
  orgId: exam?.org || null,
  examId: finalExamId,

  // 🔑 SINGLE SOURCE OF TRUTH
  quizTitle: resolvedQuizTitle || "Quiz",


  moduleName: exam?.module || moduleKey || null,

  courseTitle: exam?.module || moduleKey || "Quiz",

  score,
  percentage,
  serial
});


  } catch (e) {
    console.error("[quiz/submit] certificate save failed:", e);
  }
}


let attemptFilter = {
  examId: finalExamId,
  userId: attemptUserId
};
Object.keys(attemptFilter).forEach(
  k => attemptFilter[k] === undefined && delete attemptFilter[k]
);


    Object.keys(attemptFilter).forEach(k => attemptFilter[k] === undefined && delete attemptFilter[k]);

    let attempt = null;
    try {
      if (Object.keys(attemptFilter).length) {
       attempt = await Attempt.findOne(attemptFilter).sort({ createdAt: -1 }).exec();

       



      }
    } catch (e) {
      console.error("[quiz/submit] attempt lookup error:", e && (e.stack || e));
    }

    const now = new Date();

    // ⛔ DURATION-BASED EXPIRY (SOURCE OF TRUTH)
if (
  process.env.QUIZ_EXPIRY_ENABLED === "true" &&
  exam?.durationMinutes &&
  attempt?.startedAt
) {
  const deadline =
    new Date(attempt.startedAt).getTime() +
    exam.durationMinutes * 60 * 1000;

  if (now.getTime() > deadline) {
    return res.status(403).json({
      error: "Time is up. Quiz auto-submitted.",
      durationMinutes: exam.durationMinutes
    });
  }
}


    // ⏱️ CALCULATE QUIZ DURATION



let duration = {
  hours: 0,
  minutes: 0,
  seconds: 0,
  totalSeconds: 0
};

if (attempt?.startedAt) {
  const wallClockSeconds = Math.floor(
    (now.getTime() - new Date(attempt.startedAt).getTime()) / 1000
  );

  const cappedSeconds = exam?.durationMinutes
    ? Math.min(wallClockSeconds, exam.durationMinutes * 60)
    : Math.max(0, wallClockSeconds);

  duration = {
    hours: Math.floor(cappedSeconds / 3600),
    minutes: Math.floor((cappedSeconds % 3600) / 60),
    seconds: cappedSeconds % 60,
    totalSeconds: cappedSeconds
  };
}


// 🔑 RESOLVE REAL QUIZ TITLE FROM PARENT QUESTION
// ✅ BEFORE attemptDoc creation, load organization
let org = null;
if (exam?.org) {
  try {
    org = await Organization.findById(exam.org).lean();
  } catch (e) {
    console.error("[quiz/submit] org lookup error:", e);
  }
}
  

const attemptDoc = {
  examId: finalExamId,

  // ✅ ALWAYS STUDENT
  userId: attemptUserId,



   isPractice: (exam?.org && org?.slug === "cripfcnt-home") 
    ? !!(await Attempt.exists({ 
        examId: finalExamId, 
        userId: attemptUserId,
        status: "finished"
      }))
    : false, 
  organization: exam?.org
    ? exam.org
    : (exam?.organization || null),

  module: exam?.module || moduleKey || null,


organization: exam?.org
  ? exam.org
  : (exam?.organization || null),


  module: (exam && exam.module) ? exam.module : (moduleKey || null),

  questionIds: (exam && Array.isArray(exam.questionIds))
    ? exam.questionIds
    : qIds.map(id =>
        mongoose.isValidObjectId(id)
          ? mongoose.Types.ObjectId(id)
          : id
      ),

  answers: savedAnswers,
  score,
  duration,
 maxScore,
  passed: !!passed,
  status: "finished",
quizTitle: resolvedQuizTitle || "Quiz",

  startedAt: attempt?.startedAt,   // ✅ do NOT overwrite
  finishedAt: now,
};


    let savedAttempt = null;
    if (attempt) {
      try {
        await Attempt.updateOne({ _id: attempt._id }, { $set: attemptDoc }).exec();
        savedAttempt = await Attempt.findById(attempt._id).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] attempt update failed:", e && (e.stack || e));
      }
    } else {
      try {
        const newA = await Attempt.create(attemptDoc);
        savedAttempt = await Attempt.findById(newA._id).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] attempt create failed:", e && (e.stack || e));
      }
    }

    if (exam?.meta?.isBattle && exam?.meta?.battleId) {
  const timeTakenSec = duration?.totalSeconds ?? null;

await recordBattleResultFromExam({
    exam,
    userId: attemptUserId,
    examId: finalExamId,
    percentage,
    score,
    maxScore,
    timeTakenSec
  });
}



    if (savedAttempt && savedAttempt._id) {
  // Run in background - don't block response
  updateTopicMasteryFromAttempt(savedAttempt._id)
    .then(result => {
      if (result.skipped) {
        console.log("[QuizSubmit] Topic mastery skipped (not cripfcnt-home)");
      } else {
        console.log(`[QuizSubmit] Topic mastery updated: ${result.updated} updated, ${result.created} created`);
        if (result.topics && result.topics.length > 0) {
          console.log(`[QuizSubmit] Topics covered:`, result.topics);
        }
      }
    })
    .catch(err => {
      console.error("[QuizSubmit] Failed to update topic mastery:", err);
      // Don't fail the quiz submission if mastery tracking fails
    });
}

    // mark exam instance as used (optional)
// mark exam instance as touched (DO NOT change expiresAt)
if (exam) {
  try {
    await ExamInstance.updateOne(
      { examId: exam.examId },
      { $set: { updatedAt: now } }
    ).exec();
  } catch (e) {
    console.error("[quiz/submit] failed to update examInstance:", e);
  }
}


    // base response
    const responseJson = {
      examId: attemptDoc.examId,
      total,
      score,
      percentage,
      passThreshold,
      passed,
      details,
      debug: {
        examFound: !!exam,
        attemptSaved: !!savedAttempt
      }
    };

    // after grading + saving attempt...

    // If passed, attempt to generate certificate PDF and attach URL to response
    if (passed) {
      try {
        // For certificate name, prefer: req.user.name or savedAttempt.userName or fallback to 'Learner'
     // 🧾 Resolve certificate recipient name (supports Google + local users)
// 🧾 Resolve certificate recipient name (ALWAYS load from DB)
// 🧾 Resolve certificate recipient name
// 🧾 Resolve certificate recipient name (ALWAYS load from DB)
let recipientName = "Learner";

try {
  // 🔑 CERTIFICATE NAME RESOLUTION:
  // - cripfcnt-home: Use exam.userId (student/child)
  // - Other orgs/schools: Use savedAttempt.userId (the person who took the quiz)
  
  let certificateUserId;
  
  if (org?.slug === "cripfcnt-home") {
    // Home learning: certificate goes to the child (exam.userId)
    certificateUserId = exam?.userId || savedCertificate?.userId || null;
  } else {
    // Regular schools/orgs: certificate goes to the person who took the quiz
    // savedAttempt.userId is the quiz taker (NOT the admin who assigned it)
    certificateUserId = savedAttempt?.userId || req.user?._id || null;
  }

  console.log("[certificate] Resolving name for userId:", certificateUserId, "| org:", org?.slug);

  if (certificateUserId) {
    const fullUser = await User.findById(certificateUserId)
      .select("firstName lastName displayName name fullName email")
      .lean();

    console.log("[certificate] Found user:", {
      id: fullUser?._id,
      displayName: fullUser?.displayName,
      firstName: fullUser?.firstName,
      lastName: fullUser?.lastName,
      email: fullUser?.email
    });

    if (fullUser) {
      // 1️⃣ displayName (highest priority)
      if (fullUser.displayName?.trim()) {
        recipientName = fullUser.displayName.trim();
      }
      // 2️⃣ first + last name (students)
      else if (fullUser.firstName || fullUser.lastName) {
        recipientName = [
          fullUser.firstName || "",
          fullUser.lastName || ""
        ].join(" ").trim();
      }
      // 3️⃣ Google-style names
      else if (fullUser.name || fullUser.fullName) {
        recipientName = fullUser.name || fullUser.fullName;
      }
      // 4️⃣ Email fallback
      else if (fullUser.email) {
        recipientName = fullUser.email.split("@")[0];
      }
    }
  }

  console.log("[certificate] Final recipient name:", recipientName);
} catch (e) {
  console.warn("[certificate] failed to resolve student name", e);
}




        // Try to find organization name if possible
        let orgName = "";
        try {
          if (exam && exam.org) {
            const orgObj = await Organization.findById(exam.org).lean().exec();
            if (orgObj) orgName = orgObj.name || orgObj.title || "";
          } else if (typeof orgSlugOrId === "string") {
            const maybeOrg = await Organization.findOne({ $or: [{ slug: orgSlugOrId }, { _id: orgSlugOrId }] }).lean().exec();
            if (maybeOrg) orgName = maybeOrg.name || maybeOrg.title || "";
          }
        } catch (e) { /* ignore */ }

        const moduleNameForCert = (exam && exam.module) ? exam.module : (moduleKey || "");

console.log("CERT DEBUG:", {
  quizTitleFromClient,
  examTitle: exam?.title,
  examQuizTitle: exam?.quizTitle,
  examName: exam?.name,
  examModule: exam?.module
});


const certResult = await generateCertificatePdf({
  name: recipientName,
  orgName,

  // ✅ USE SAVED CERTIFICATE TITLE
quizTitle:
  savedCertificate?.quizTitle ||
  resolvedQuizTitle ||
  exam?.quizTitle ||
  exam?.title ||
  quizTitleFromClient ||
  moduleNameForCert ||
  "Quiz",

  moduleName: savedCertificate?.moduleName || null,

  score,
  percentage,
  date: now,
  req
});




        if (certResult && certResult.filename) {
          const site = (process.env.SITE_URL || "").replace(/\/$/, "");
          const baseForMedia = site || `${(req.get("x-forwarded-proto") || req.protocol)}://${req.get("host")}`;
          const certUrl = `${baseForMedia}/docs/certificates/${certResult.filename}`;
          responseJson.certificateUrl = certUrl;
          responseJson.certificateMethod = certResult.method || null;
        }
      } catch (certErr) {
        console.error("[quiz/submit] certificate generation failed:", certErr && (certErr.stack || certErr));
        // don't fail the whole request if certificate generation fails
      }
    }


// ✅ Attach battle redirect payload for client
if (exam?.meta?.isBattle && exam?.meta?.battleId) {
  responseJson.battle = {
    battleId: String(exam.meta.battleId),
    resultsUrl: `/arena/results?battleId=${encodeURIComponent(String(exam.meta.battleId))}`
  };
}

    return res.json(responseJson);
  } catch (err) {
    console.error("[POST /api/lms/quiz/submit] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to score quiz", detail: String(err && err.message) });
  }
});

export {
  generateCertificatePdf,
};

export default router;