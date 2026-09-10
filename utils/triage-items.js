// utils/triage-items.js
// ─────────────────────────────────────────────────────────────────────────────
// Turn the classifier's 3,314 flags into an ACTIONABLE, sorted to-do list, and
// produce the difficulty statistics needed to set course grade bands.
//
// READ-ONLY. It writes nothing to Mongo and calls no API — it only reads the
// fields classify-items.js already saved (difficulty, topic, meta.bloom,
// meta.answerQuality, meta.isOutOfScope) and writes CSV/JSON files to disk.
//
// It splits flagged questions into buckets, and CRUCIALLY separates genuine
// defects from your house style. A question like "According to CRIPFCnt, X
// primarily results from…" is not broken — it asks the learner to answer from
// your framework's viewpoint. Those land in framework_style.csv (low priority),
// so the real defects (wrong_key, multiple_correct) aren't buried.
//
// OUTPUT (in ./exports/triage/):
//   out_of_scope.csv        items the AI judged off-topic (e.g. leaked maths) → exclude
//   wrong_key.csv           marked answer looks incorrect → FIX FIRST
//   multiple_correct.csv    two defensible answers → fix options
//   ambiguous_real.csv      genuinely under-specified stems → tighten
//   framework_style.csv     "According to CRIPFCnt…" false-positives → likely fine
//   summary.json            counts + difficulty histogram + per-area stats
//
// USAGE
//   node -r dotenv/config utils/triage-items.js
//   node -r dotenv/config utils/triage-items.js --org cripfcnt-school
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import mongoose from "mongoose";

const MONGO_URI =
  process.env.MONGODB_URI || process.env.MONGO_URI ||
  process.env.DATABASE_URL || process.env.MONGO_URL;

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const ORG_SLUG = val("--org", "cripfcnt-school");
const OUT_DIR = path.resolve(val("--out", "./exports/triage"));

// House-style pattern: questions that ask for the answer FROM the CRIPFCnt
// framework's viewpoint. Ambiguous flags matching this are almost always fine.
const FRAMEWORK_RE = /\b(according to|in|from|within|per)\s+(the\s+)?cripfcnt\b|\bcripfcnt\s+(defines|logic|perspective|framework|pillar|prioritis|view|model|approach)/i;

const Organization =
  mongoose.models.Organization ||
  mongoose.model("Organization", new mongoose.Schema({}, { strict: false }), "organizations");
const Question =
  mongoose.models.Question ||
  mongoose.model("Question", new mongoose.Schema({}, { strict: false }), "questions");

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file, rows, headers) {
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => csvCell(r[h])).join(","));
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

function optionsStr(q) {
  return (q.choices || []).map((c, i) => {
    const text = typeof c === "string" ? c : (c?.text || "");
    const key = (typeof q.correctIndex === "number" && q.correctIndex === i) ? "*" : "";
    return `${String.fromCharCode(65 + i)}${key}) ${text}`;
  }).join(" | ");
}
function markedAnswer(q) {
  if (typeof q.correctIndex !== "number") return "";
  const c = (q.choices || [])[q.correctIndex];
  return c ? (typeof c === "string" ? c : c.text || "") : "";
}

async function main() {
  if (!MONGO_URI) throw new Error("No Mongo URI (set MONGODB_URI).");
  await mongoose.connect(MONGO_URI);
  const org = await Organization.findOne({ slug: ORG_SLUG }).lean();
  if (!org) throw new Error(`Org not found: ${ORG_SLUG}`);
  const orgId = new mongoose.Types.ObjectId(String(org._id));

  const parents = await Question.find({ organization: orgId, type: "comprehension" })
    .select("_id text quizTitle series category meta questionIds").lean();

  // child -> parent lookup
  const childToParent = {};
  const parentById = {};
  const childIds = [];
  for (const p of parents) {
    parentById[String(p._id)] = p;
    for (const cid of (p.questionIds || [])) {
      const s = String(cid);
      childToParent[s] = String(p._id);
      if (mongoose.isValidObjectId(s)) childIds.push(s);
    }
  }

  const children = childIds.length
    ? await Question.find({ _id: { $in: childIds } })
        .select("_id text choices correctIndex difficulty topic meta").lean()
    : [];

  const buckets = { out_of_scope: [], wrong_key: [], multiple_correct: [], ambiguous_real: [], framework_style: [] };
  const diffHist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, unrated: 0 };
  const perArea = {}; // category -> { passages, qCount, diffSum, diffN }

  // passage-level tallies
  for (const p of parents) {
    const cat = p.category || "uncategorised";
    perArea[cat] = perArea[cat] || { passages: 0, qCount: 0, diffSum: 0, diffN: 0, band: {} };
    perArea[cat].passages++;
    const band = p.meta?.difficultyBand || "unrated";
    perArea[cat].band[band] = (perArea[cat].band[band] || 0) + 1;
  }

  for (const c of children) {
    const d = Number(c.difficulty);
    if (d >= 1 && d <= 5) diffHist[d]++; else diffHist.unrated++;

    const parent = parentById[childToParent[String(c._id)]] || {};
    const cat = parent.category || "uncategorised";
    if (perArea[cat]) { perArea[cat].qCount++; if (d >= 1 && d <= 5) { perArea[cat].diffSum += d; perArea[cat].diffN++; } }

    const aq = c.meta?.answerQuality || "ok";
    const oos = !!c.meta?.isOutOfScope;
    if (!oos && aq === "ok") continue;

    const row = {
      childId: String(c._id),
      parentId: childToParent[String(c._id)] || "",
      passage: parent.quizTitle || parent.text || "",
      series: parent.series || "",
      area: cat,
      question: (c.text || "").slice(0, 300),
      options: optionsStr(c),
      marked_answer: markedAnswer(c),
      difficulty: c.difficulty || "",
      bloom: c.meta?.bloom || "",
      flag: oos ? "out_of_scope" : aq,
      confidence: c.meta?.aiConfidence ?? ""
    };

    if (oos) buckets.out_of_scope.push(row);
    else if (aq === "wrong_key") buckets.wrong_key.push(row);
    else if (aq === "multiple_correct") buckets.multiple_correct.push(row);
    else if (aq === "ambiguous") {
      if (FRAMEWORK_RE.test(c.text || "")) buckets.framework_style.push(row);
      else buckets.ambiguous_real.push(row);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const headers = ["childId","parentId","passage","series","area","question","options","marked_answer","difficulty","bloom","flag","confidence"];
  for (const [name, rows] of Object.entries(buckets)) {
    writeCsv(path.join(OUT_DIR, `${name}.csv`), rows, headers);
  }

  // per-area averages
  const areaSummary = {};
  for (const [cat, s] of Object.entries(perArea)) {
    areaSummary[cat] = {
      passages: s.passages,
      questions: s.qCount,
      avgDifficulty: s.diffN ? Number((s.diffSum / s.diffN).toFixed(2)) : null,
      passageBands: s.band
    };
  }

  const summary = {
    org: ORG_SLUG,
    generatedAt: new Date().toISOString(),
    totals: {
      passages: parents.length,
      questions: children.length,
      flagged_real_defects: buckets.out_of_scope.length + buckets.wrong_key.length + buckets.multiple_correct.length + buckets.ambiguous_real.length,
      out_of_scope: buckets.out_of_scope.length,
      wrong_key: buckets.wrong_key.length,
      multiple_correct: buckets.multiple_correct.length,
      ambiguous_real: buckets.ambiguous_real.length,
      framework_style_false_positives: buckets.framework_style.length
    },
    difficultyHistogram: diffHist,
    perArea: areaSummary
  };
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(`\nTriage complete → ${OUT_DIR}`);
  console.log(`Passages: ${summary.totals.passages} · Questions: ${summary.totals.questions}`);
  console.log(`\nREAL defects to act on:`);
  console.log(`   out_of_scope     ${summary.totals.out_of_scope.toString().padStart(5)}  (exclude / delete)`);
  console.log(`   wrong_key        ${summary.totals.wrong_key.toString().padStart(5)}  (FIX FIRST)`);
  console.log(`   multiple_correct ${summary.totals.multiple_correct.toString().padStart(5)}  (fix options)`);
  console.log(`   ambiguous_real   ${summary.totals.ambiguous_real.toString().padStart(5)}  (tighten wording)`);
  console.log(`\nProbably fine (house style): framework_style ${summary.totals.framework_style_false_positives}`);
  console.log(`\nDifficulty spread:`, diffHist);
  console.log(`\nsummary.json has per-area passage counts + avg difficulty (for grade bands).`);

  await mongoose.disconnect();
}

main().catch(err => { console.error("❌", err && (err.stack || err.message || err)); process.exit(1); });