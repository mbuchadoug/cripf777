// utils/classify-items.js
// ─────────────────────────────────────────────────────────────────────────────
// AI item classifier for the CRIPFCnt course grading engine.
//
// Reads your comprehension passages + their child questions from Mongo, asks the
// Claude API to classify each on world-class assessment dimensions, and writes
// the results back into fields you ALREADY have (difficulty, topic, meta.*).
// A later empirical pass (p-value + discrimination from Attempt data) can then
// override these AI estimates as real response data accumulates.
//
// WHAT IT TAGS (per question)
//   bloom            remember|understand|apply|analyze|evaluate|create
//   difficulty       1..5  (anchored to expected success: 1≈85%+, 3≈60%, 5≈30%-)
//   topic            kebab-case micro-skill
//   answer_quality   ok|ambiguous|wrong_key|multiple_correct   (item-quality gate)
//   distractor       strong|weak
//   out_of_scope     true|false
//   confidence       0..1
// PER PASSAGE
//   difficultyBand   foundation|intermediate|advanced (mean of its questions)
//   readingComplexity  low|medium|high
//
// SAFETY / ROBUSTNESS
//   • --dry-run           classify + print, write NOTHING
//   • --limit N           only process N passages (test cheaply first!)
//   • --selftest          run the JSON parser/aggregator on a fixture, no DB/API
//   • skips items already classified unless --force
//   • NEVER overwrites an item where meta.manualOverride === true
//   • batches questions per API call (cheaper), retries on 429/5xx with backoff
//   • idempotent + resumable; writes a JSON report to ./exports/
//   • prints token usage so you can see exactly what the run cost
//
// RUN ORDER (respect your credits):
//   1) node -r dotenv/config utils/classify-items.js --selftest
//   2) node -r dotenv/config utils/classify-items.js --limit 3 --dry-run   ← eyeball
//   3) node -r dotenv/config utils/classify-items.js --limit 3             ← writes 3
//   4) node -r dotenv/config utils/classify-items.js                       ← full bank
//
// ENV
//   MONGODB_URI (or MONGO_URI / DATABASE_URL / MONGO_URL)
//   ANTHROPIC_API_KEY
//   ANTHROPIC_MODEL         default: claude-haiku-4-5-20251001  (cheap, capable)
//                           use claude-sonnet-5 for higher-quality classification
//   ANTHROPIC_PRICE_IN / ANTHROPIC_PRICE_OUT   optional, USD per 1M tokens, for a
//                           cost estimate in the final report (else tokens only)
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import mongoose from "mongoose";

// ── env ──────────────────────────────────────────────────────────────────────
const MONGO_URI =
  process.env.MONGODB_URI || process.env.MONGO_URI ||
  process.env.DATABASE_URL || process.env.MONGO_URL;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const PRICE_IN = Number(process.env.ANTHROPIC_PRICE_IN || 0);   // USD / 1M in
const PRICE_OUT = Number(process.env.ANTHROPIC_PRICE_OUT || 0); // USD / 1M out

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const DRY = has("--dry-run");
const FORCE = has("--force");
const SELFTEST = has("--selftest");
const LIMIT = Number(val("--limit", 0)) || 0;
const ORG_SLUG = val("--org", "cripfcnt-school");
const BATCH = Math.max(1, Number(val("--batch", 6)) || 6);
const OUT_DIR = path.resolve(val("--out", "./exports"));

// ── the classification rubric (this is the heart; keep it stable) ────────────
const SYSTEM = `You are a psychometric item classifier for a professional assessment platform.
You classify multiple-choice questions on recognised assessment dimensions.
Return ONLY a JSON array, no prose, no markdown fences.

For EACH question object you receive (keyed by "id"), return one object:
{
 "id": "<echo the id>",
 "bloom": "remember|understand|apply|analyze|evaluate|create",
 "difficulty": 1-5,
 "topic": "kebab-case-micro-skill",
 "answer_quality": "ok|ambiguous|wrong_key|multiple_correct",
 "distractor": "strong|weak",
 "out_of_scope": true|false,
 "confidence": 0.0-1.0
}

DIFFICULTY is anchored to the expected proportion of minimally-competent
candidates who answer correctly:
 1 = very easy   (~85%+ correct)
 2 = easy        (~75%)
 3 = moderate    (~60%)
 4 = hard        (~45%)
 5 = very hard   (~30% or fewer)
Judge difficulty from cognitive load, number of reasoning steps, and how
plausible the distractors are - NOT from topic obscurity alone.

answer_quality flags item defects:
 "wrong_key"        the indicated correct answer looks incorrect
 "multiple_correct" more than one option is defensibly correct
 "ambiguous"        the stem is unclear or under-specified
 "ok"               none of the above
distractor = "weak" if a wrong option is implausible enough that nobody would pick it.
out_of_scope = true only if the item does not belong to professional/organisational
learning (e.g. stray primary-school arithmetic in a governance bank).`;

// ── loose read/write models (no validation on read; we set specific fields) ──
const Organization =
  mongoose.models.Organization ||
  mongoose.model("Organization", new mongoose.Schema({}, { strict: false }), "organizations");
const Question =
  mongoose.models.Question ||
  mongoose.model("Question", new mongoose.Schema({}, { strict: false }), "questions");

// ── helpers ──────────────────────────────────────────────────────────────────
function extractJsonArray(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function qPayload(q) {
  // Build a compact, token-lean payload for one child question.
  const choices = (q.choices || []).map((c, i) => {
    const text = typeof c === "string" ? c : (c?.text || "");
    const mark = (typeof q.correctIndex === "number" && q.correctIndex === i) ? " [KEY]" : "";
    return `${String.fromCharCode(65 + i)}) ${text}${mark}`;
  }).join("  ");
  return { id: String(q._id), q: String(q.text || "").slice(0, 600), choices: choices.slice(0, 800) };
}

async function callClaude(items, attempt = 1) {
  const body = {
    model: MODEL,
    max_tokens: Math.min(4096, 220 * items.length + 200),
    system: SYSTEM,
    messages: [{ role: "user", content: "Classify these questions:\n" + JSON.stringify(items) }]
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt <= 5) {
      const wait = Math.min(30000, 1000 * 2 ** attempt);
      await new Promise(r => setTimeout(r, wait));
      return callClaude(items, attempt + 1);
    }
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const usage = data.usage || { input_tokens: 0, output_tokens: 0 };
  return { rows: extractJsonArray(text) || [], usage };
}

function diffBand(avg) {
  if (avg <= 2.3) return "foundation";
  if (avg <= 3.6) return "intermediate";
  return "advanced";
}

// ── self-test (no DB, no API): proves parsing + aggregation are sound ────────
function selftest() {
  const fixture = `Sure! [
    {"id":"a","bloom":"analyze","difficulty":4,"topic":"leverage","answer_quality":"ok","distractor":"strong","out_of_scope":false,"confidence":0.8},
    {"id":"b","bloom":"remember","difficulty":2,"topic":"definitions","answer_quality":"wrong_key","distractor":"weak","out_of_scope":false,"confidence":0.6}
  ]`;
  const rows = extractJsonArray(fixture);
  if (!rows || rows.length !== 2) throw new Error("parser failed");
  const avg = (rows[0].difficulty + rows[1].difficulty) / 2;
  const band = diffBand(avg);
  console.log("selftest parse OK:", rows.length, "rows · avg", avg, "· band", band);
  console.log("payload sample:", qPayload({ _id: "x", text: "What is leverage?", choices: [{ text: "power" }, { text: "rope" }], correctIndex: 0 }));
  console.log("✅ selftest passed");
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (SELFTEST) { selftest(); return; }
  if (!MONGO_URI) throw new Error("No Mongo URI (set MONGODB_URI).");
  if (!API_KEY) throw new Error("No ANTHROPIC_API_KEY set.");

  await mongoose.connect(MONGO_URI);
  const org = await Organization.findOne({ slug: ORG_SLUG }).lean();
  if (!org) throw new Error(`Org not found: ${ORG_SLUG}`);
  const orgId = new mongoose.Types.ObjectId(String(org._id));

  // Load comprehension passages for this org
  let parents = await Question.find({ organization: orgId, type: "comprehension" })
    .select("_id text quizTitle passage questionIds category series meta difficulty")
    .lean();
  if (LIMIT) parents = parents.slice(0, LIMIT);
  console.log(`Passages to consider: ${parents.length}${LIMIT ? ` (--limit ${LIMIT})` : ""}${DRY ? " · DRY RUN" : ""}`);

  // Gather child ids
  const childIds = [];
  for (const p of parents) for (const id of (p.questionIds || [])) {
    const s = String(id);
    if (mongoose.isValidObjectId(s)) childIds.push(s);
  }
  const children = childIds.length
    ? await Question.find({ _id: { $in: childIds } })
        .select("_id text choices correctIndex difficulty topic meta").lean()
    : [];
  const childMap = {}; for (const c of children) childMap[String(c._id)] = c;

  // Which children need classifying?
  const todo = children.filter(c => {
    if (c.meta?.manualOverride) return false;                 // never touch human-set
    if (!FORCE && c.meta?.aiCategorised && c.difficulty) return false; // already done
    return true;
  });
  console.log(`Child questions: ${children.length} · to classify now: ${todo.length}`);

  // Classify in batches
  const report = { model: MODEL, startedAt: new Date().toISOString(), classified: 0, flagged: [], tokensIn: 0, tokensOut: 0, errors: [] };
  const classifiedById = {};
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const payload = slice.map(qPayload);
    try {
      const { rows, usage } = await callClaude(payload);
      report.tokensIn += usage.input_tokens || 0;
      report.tokensOut += usage.output_tokens || 0;
      const byId = {}; for (const r of rows) byId[String(r.id)] = r;
      for (const q of slice) {
        const r = byId[String(q._id)];
        if (!r) { report.errors.push({ id: String(q._id), why: "missing in response" }); continue; }
        classifiedById[String(q._id)] = r;
        report.classified++;
        if (r.answer_quality && r.answer_quality !== "ok") {
          report.flagged.push({ id: String(q._id), issue: r.answer_quality, text: String(q.text || "").slice(0, 80) });
        }
        if (!DRY) {
          const diff = Math.max(1, Math.min(5, Number(r.difficulty) || 3));
          await Question.updateOne({ _id: q._id }, { $set: {
            difficulty: diff,
            topic: r.topic || q.topic || null,
            "meta.bloom": r.bloom || null,
            "meta.aiDifficulty": diff,
            "meta.answerQuality": r.answer_quality || "ok",
            "meta.distractorQuality": r.distractor || null,
            "meta.isOutOfScope": !!r.out_of_scope,
            "meta.aiConfidence": Number(r.confidence) || null,
            "meta.aiCategorised": true,
            updatedAt: new Date()
          } });
        }
      }
      process.stdout.write(`  batch ${Math.floor(i / BATCH) + 1}: +${slice.length} (${report.classified}/${todo.length})\r`);
    } catch (e) {
      report.errors.push({ batchStart: i, why: String(e.message || e) });
    }
  }
  console.log("");

  // Aggregate passage-level difficulty from (new or existing) child difficulties
  let passageUpdates = 0;
  for (const p of parents) {
    const kids = (p.questionIds || []).map(String).map(id => {
      const fresh = classifiedById[id];
      if (fresh) return Math.max(1, Math.min(5, Number(fresh.difficulty) || 3));
      const existing = childMap[id];
      return existing && existing.difficulty ? Number(existing.difficulty) : null;
    }).filter(v => v != null);
    if (!kids.length) continue;
    const avg = kids.reduce((a, b) => a + b, 0) / kids.length;
    const band = diffBand(avg);
    if (!DRY) {
      await Question.updateOne({ _id: p._id }, { $set: {
        "meta.aiDifficulty": Number(avg.toFixed(2)),
        "meta.difficultyBand": band,
        "meta.aiCategorised": true,
        updatedAt: new Date()
      } });
    }
    passageUpdates++;
  }

  report.finishedAt = new Date().toISOString();
  report.passageBandsWritten = DRY ? 0 : passageUpdates;
  if (PRICE_IN || PRICE_OUT) {
    report.estCostUsd = Number(((report.tokensIn / 1e6) * PRICE_IN + (report.tokensOut / 1e6) * PRICE_OUT).toFixed(4));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rpt = path.join(OUT_DIR, `classification-report-${Date.now().toString(36)}.json`);
  fs.writeFileSync(rpt, JSON.stringify(report, null, 2));

  console.log(`\n${DRY ? "DRY RUN - nothing written." : "Done."}`);
  console.log(`Classified: ${report.classified} questions · passage bands: ${report.passageBandsWritten}`);
  console.log(`Tokens: in ${report.tokensIn} · out ${report.tokensOut}${report.estCostUsd != null ? ` · ≈ $${report.estCostUsd}` : ""}`);
  console.log(`Item-quality flags (review these): ${report.flagged.length}`);
  if (report.flagged.length) for (const f of report.flagged.slice(0, 10)) console.log(`   • [${f.issue}] ${f.text}…`);
  console.log(`Report: ${rpt}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error("❌", err && (err.stack || err.message || err)); process.exit(1); });