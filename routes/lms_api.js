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
    (s === undefined || s === null)
      ? ""
      : String(s)
          .replace(/&/g,"&amp;")
          .replace(/</g,"&lt;")
          .replace(/>/g,"&gt;");

  const org = (orgName || "").toLowerCase();

  const isNyaradzo = /nyaradzo/.test(org);
  const isCripfcnt = /cripfcnt/.test(org);
  const isStEurit =
  /st[\s\-]?eurit/.test(org) ||
  /eurit/.test(org);

const isWinchester =
  /winchester/.test(org);


  /* ===============================
     🎨 BRAND CONFIG
  =============================== */
 const brand = isStEurit
  ? {
      primary: "#111111", // black
      accent: "#D4AF37",  // gold
      logo: `${process.env.SITE_URL || ""}/assets/st-eurit-logo.png`,
      title: "St Eurit International School Certificate"
    }

      : isWinchester
  ? {
      primary: "#1F3C88", // navy blue
      accent: "#8B1E2D",  // maroon
      logo: `${process.env.SITE_URL || ""}/assets/winchester-logo.jpg`,
      title: "Winchester School Certificate"
    }
  : isNyaradzo
  ? {
      primary: "#0a2e5c",
      accent: "#c9a227",
      logo: `${process.env.SITE_URL || ""}/assets/nyaradzo-logo.png`,
      title: "Nyaradzo Group Training Certificate"
    }
  : isCripfcnt
  ? {
      primary: "#0f5132",
      accent: "#20c997",
      logo: `${process.env.SITE_URL || ""}/assets/cripfcnt-logo.png`,
      title: "CRIPFCNT Training Certificate"
    }
  : {
      primary: "#222",
      accent: "#f1b000",
      logo: "",
      title: "Certificate of Completion"
    };

  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>${esc(brand.title)}</title>

<style>
@page { margin: 0; }
body {
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  margin:0;
  background:#f2f2f5;
}
.wrap {
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:40px;
}
.card {
  width:100%;
  max-width:900px;
  background:white;
  padding:60px 52px 52px;
  border-radius:14px;
  text-align:center;
  box-shadow:0 12px 50px rgba(0,0,0,0.12);
  position:relative;
  overflow:hidden;
}

/* TOP BAR */
.card::before {
  content:"";
  position:absolute;
  top:0;
  left:0;
  right:0;
  height:36px;
  background:linear-gradient(
    90deg,
    ${brand.primary},
    ${brand.primary}cc
  );
}

/* ACCENT STRIPE */
.card::after {
  content:"";
  position:absolute;
  top:36px;
  left:0;
  right:0;
  height:6px;
  background:${brand.accent};
}

.logo img {
  max-height:80px;
  margin:20px auto 10px;
}

h1 {
  margin:20px 0 6px;
  font-size:34px;
  color:${brand.primary};
  font-weight:800;
}

.subtitle {
  margin-top:8px;
  font-size:14px;
  color:#666;
}

.recipient {
  margin-top:30px;
  font-size:30px;
  font-weight:900;
  color:#111;
}

.quiz {
  margin-top:16px;
  font-size:20px;
  font-weight:800;
  color:${brand.primary};
}

.details {
  margin-top:36px;
  display:flex;
  justify-content:center;
  gap:60px;
}

.detail .val {
  font-size:22px;
  font-weight:900;
}

.footer {
  margin-top:46px;
  font-size:13px;
  color:#777;
}

.seal {
  display:inline-block;
  margin-top:14px;
  padding:10px 20px;
  background:${brand.accent};
  color:#111;
  font-weight:900;
  border-radius:8px;
}
</style>
</head>

<body>
<div class="wrap">
  <div class="card">

    ${brand.logo ? `
    <div class="logo">
      <img src="${brand.logo}" />
    </div>` : ""}

    <h1>${esc(brand.title)}</h1>
    <div class="subtitle">This certifies that</div>

    <div class="recipient">${esc(name)}</div>

    <div class="subtitle">has successfully completed the quiz</div>

 <div class="quiz">
  ${esc(quizTitle || moduleName || "Quiz")}
</div>


    <div class="details">
      <div class="detail">
        <div class="val">${esc(score)}</div>
        <div>Score</div>
      </div>
      <div class="detail">
        <div class="val">${esc(percentage)}%</div>
        <div>Percentage</div>
      </div>
      <div class="detail">
        <div class="val">${esc(
          date
            ? new Date(date).toISOString().slice(0,10)
            : new Date().toISOString().slice(0,10)
        )}</div>
        <div>Date</div>
      </div>
    </div>

    <div class="footer">
      Awarded by ${esc(orgName || "Organization")}
      <div class="seal">Verified</div>
    </div>

  </div>
</div>
</body>
</html>
`;
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
        await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
        await page.emulateMediaType("screen");
        await page.pdf({ path: filepath, format: "A4", printBackground: true, margin: { top: "20mm", bottom: "20mm", left: "20mm", right: "20mm" } });
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


    // ⛔ QUIZ EXPIRY ENFORCEMENT (SERVER-SIDE — SOURCE OF TRUTH)
// ⛔ CALENDAR-BASED EXPIRY ONLY
if (process.env.QUIZ_EXPIRY_ENABLED === "true" && exam?.expiresAt) {
  if (new Date() > new Date(exam.expiresAt)) {
    return res.status(403).json({
      error: "Quiz expired",
      expiredAt: exam.expiresAt
    });
  }
}




    // 🔑 SINGLE SOURCE OF TRUTH — AFTER exam is known
// ✅ SAFE EXAM ID RESOLUTION
let finalExamId;

// CASE 1: Quiz came from ExamInstance (parent/assigned flow)
if (exam?.examId) {
  finalExamId = exam.examId;
}
// CASE 2: Legacy / other schools (sampling, org quizzes, etc.)
else if (examId) {
  finalExamId = examId;
}
// CASE 3: Absolute fallback (keep old behavior)
else {
  finalExamId = "exam-" + Date.now().toString(36);
}



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
  }

  let selectedText = "";
  if (qdoc) {
    const choices = qdoc.choices || [];
    const c = choices[canonicalIndex];
    selectedText =
      typeof c === "string" ? c : (c?.text || "");
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
  exam?.quizTitle ||
  exam?.title ||
  null;

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
  userId: exam?.userId || attempt?.userId,
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


    // Find / update or create Attempt
  // ✅ ALWAYS lookup attempt by finalExamId
// 🔑 ALWAYS SAVE ATTEMPT AGAINST STUDENT (NOT PARENT)
const attemptUserId =
  exam?.userId ||               // assigned exam → student
  exam?.learnerId ||            // future-proof
  payload.userId ||             // explicit student id (if sent)
  null;

if (!attemptUserId) {
  throw new Error("Attempt userId (student) could not be resolved");
}

let attemptFilter = {
  examId: finalExamId,
  userId: attemptUserId,
  organization: exam?.org || undefined
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
  quizTitle: savedCertificate?.quizTitle || "Quiz",

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
