// extract-assessments.js
// ─────────────────────────────────────────────────────────────────────────────
// Export CRIPFCnt assessment titles (and optionally passages + questions +
// answers) for a given "Professional Area" (category) into shareable files.
//
// The org dashboard groups comprehension Questions by `series` and the sidebar
// "Professional Areas" are just the `category` field, title-cased:
//     structural-responsibility  ->  "Structural Responsibility"
//     interpretive-frameworks    ->  "Interpretive Frameworks"
//
// This script replicates that read path directly against Mongo. It is
// self-contained (loose schemas, strict:false) so it does NOT depend on your
// model file paths — drop it anywhere in the project and run with node.
//
// USAGE
//   node extract-assessments.js                         # list all areas + counts
//   node extract-assessments.js structural-responsibility
//   node extract-assessments.js structural-responsibility --full
//   node extract-assessments.js interpretive-frameworks --full --pdf
//   node extract-assessments.js all --full              # every area
//
// FLAGS
//   --full     include passage + child questions + correct answers
//   --pdf      also render a PDF (uses puppeteer with your VPS-safe launch flags)
//   --loose    mirror the dashboard's fuzzy inclusion (series/keyword matches),
//              not just strict category equality
//   --org <slug>   target org slug (default: cripfcnt-school)
//   --out <dir>    output directory (default: ./exports)
//
// CONNECTION
//   Reads MONGODB_URI (or MONGO_URI / DATABASE_URL / MONGO_URL) from env,
//   same as your fixTutorIndex.js. Load your .env first if needed:
//       node -r dotenv/config extract-assessments.js structural-responsibility
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import mongoose from "mongoose";

// ── Connection string (mirrors fixTutorIndex.js) ─────────────────────────────
const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DATABASE_URL ||
  process.env.MONGO_URL;

if (!MONGO_URI) {
  console.error("❌ No Mongo connection string. Set MONGODB_URI (or load your .env).");
  process.exit(1);
}

// ── CLI parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith("--")));
const positional = argv.filter(a => !a.startsWith("--"));

function flagValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return fallback;
}

const CATEGORY_ARG = positional[0] || null; // e.g. structural-responsibility | all | null
const WANT_FULL = flags.has("--full");
const WANT_PDF = flags.has("--pdf");
const WANT_LOOSE = flags.has("--loose");
const ORG_SLUG = flagValue("--org", "cripfcnt-school");
const OUT_DIR = path.resolve(flagValue("--out", "./exports"));

// ── Loose read-only models (no validation, avoids enum issues on read) ───────
const looseOpts = { strict: false, collection: undefined };
const Organization =
  mongoose.models.Organization ||
  mongoose.model("Organization", new mongoose.Schema({}, { strict: false }), "organizations");
const Question =
  mongoose.models.Question ||
  mongoose.model("Question", new mongoose.Schema({}, { strict: false }), "questions");

// ── Keyword map copied from the dashboard (for --loose parity) ───────────────
const CATEGORY_TOPIC_KEYWORDS = {
  "governance": ["governance", "government", "institution", "ministry", "parliament", "cabinet"],
  "structural-responsibility": ["structural", "responsibility", "blame", "obligation", "outsourcing"],
  "interpretive-frameworks": ["interpretation", "framework", "lens", "perspective", "worldview"],
  "systems-thinking": ["system", "systems-thinking", "complexity", "feedback", "interdependence"],
  "consciousness-studies": ["consciousness", "awareness", "perception", "mindfulness"],
  "civilisation-theory": ["civilisation", "civilization", "society", "culture", "heritage"],
  "performance-metrics": ["metrics", "measurement", "kpi", "indicator", "evaluation"],
  "institutional-accountability": ["accountability", "transparency", "oversight", "audit"],
  "financial-accountability": ["financial", "audit", "treasury", "expenditure", "budget"],
  "language-recalibration": ["language", "terminology", "recalibration", "semantics"],
  "strategic-leadership": ["leadership", "strategic", "vision", "decision", "executive"],
  "frequencies-and-influence": ["frequencies", "influence", "energy", "vibration", "signal"],
  "education": ["education", "curriculum", "school", "learning", "teaching"],
  "digital-ethics": ["digital-ethics", "privacy", "surveillance", "algorithmic", "bias"],
  "administration": ["administration", "civil-service", "bureaucracy", "public-administration"],
  "philosophical-inquiry": ["philosophy", "ethics", "morality", "ontology", "epistemology"],
  "organisational-development": ["organisational", "org-culture", "capacity-building"],
  "public-sector-ethics": ["ethics", "integrity", "misconduct", "professional-standards"],
  "motivation": ["motivation", "incentive", "intrinsic", "extrinsic", "drive"],
  "social-contract": ["social-contract", "citizenship", "obligation", "rights-and-duties"],
  "environmental-governance": ["environment", "climate", "ecology", "sustainability"],
  "social-justice": ["social-justice", "equality", "discrimination", "race", "gender"],
  "negotiation-dynamics": ["negotiation", "bargain", "deal", "agreement", "leverage"],
  "technology-governance": ["technology", "digital", "data", "cyber", "ai"],
  "critical-thinking": ["critical-thinking", "analysis", "reasoning", "logic"],
  "ai-governance": ["ai-governance", "ai-regulation", "model-governance", "responsible-ai"],
  "human-resources": ["human-resources", "hr", "talent", "workforce"],
  "change-management": ["change", "transformation", "reform", "restructuring"],
  "narrative-framing": ["narrative", "story", "framing", "agenda", "spin"],
  "public-policy": ["policy", "legislation", "regulation", "law-reform"]
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function slugToLabel(s) {
  return (s || "")
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function matchesCategory(doc, slug) {
  const cat = String(doc.category || doc.meta?.category || "").toLowerCase().trim();
  if (cat === slug) return true;
  if (!WANT_LOOSE) return false;

  // Fuzzy fallback, matching the dashboard: series contains a category part,
  // or a topic matches the category keyword list.
  const series = String(doc.series || "").toLowerCase();
  const catParts = slug.split("-").filter(p => p.length >= 5);
  if (series && catParts.some(p => series.includes(p))) return true;

  const kw = CATEGORY_TOPIC_KEYWORDS[slug] || [];
  const topics = (doc.topics || []).map(t => String(t).toLowerCase());
  if (topics.some(t => kw.some(k => t.includes(k) || k.includes(t)))) return true;

  return false;
}

// ── Load one category into a { series -> [quiz] } structure ──────────────────
async function loadCategory(orgId, slug) {
  const all = await Question.find({
    organization: orgId,
    type: "comprehension",
    "meta.isOutOfScope": { $ne: true }
  })
    .select("_id text quizTitle series category level seriesOrder questionIds passage topics meta createdAt")
    .sort({ series: 1, seriesOrder: 1, createdAt: -1 })
    .lean();

  const parents = all.filter(q => matchesCategory(q, slug));

  // Pull child questions if we need passages/answers
  let childMap = {};
  if (WANT_FULL && parents.length) {
    const childIds = [];
    for (const p of parents) {
      for (const id of p.questionIds || []) {
        const s = String(id);
        if (mongoose.isValidObjectId(s)) childIds.push(s);
      }
    }
    if (childIds.length) {
      const children = await Question.find({ _id: { $in: childIds } })
        .select("_id text choices correctIndex")
        .lean();
      for (const c of children) childMap[String(c._id)] = c;
    }
  }

  const bySeries = {};
  for (const p of parents) {
    const seriesKey = p.series || "general";
    if (!bySeries[seriesKey]) {
      bySeries[seriesKey] = {
        seriesSlug: seriesKey,
        seriesLabel: slugToLabel(seriesKey),
        level: p.level || "foundation",
        quizzes: []
      };
    }
    const questionIds = (p.questionIds || []).map(String);
    const quiz = {
      id: String(p._id),
      title: p.quizTitle || p.text || "Untitled",
      level: p.level || "foundation",
      questionCount: questionIds.length,
      seriesOrder: p.seriesOrder || 99,
      passage: WANT_FULL ? (p.passage || "") : null,
      questions: []
    };
    if (WANT_FULL) {
      for (const cid of questionIds) {
        const c = childMap[cid];
        if (!c) continue;
        const choices = (c.choices || []).map((ch, i) => ({
          label: ch.label || String.fromCharCode(65 + i),
          text: typeof ch === "string" ? ch : (ch.text || ""),
          correct: typeof c.correctIndex === "number" && c.correctIndex === i
        }));
        quiz.questions.push({ text: c.text || "", choices });
      }
    }
    bySeries[seriesKey].quizzes.push(quiz);
  }

  for (const s of Object.values(bySeries)) {
    s.quizzes.sort((a, b) => (a.seriesOrder || 99) - (b.seriesOrder || 99));
  }
  return bySeries;
}

// ── Renderers ────────────────────────────────────────────────────────────────
function renderText(slug, bySeries) {
  const label = slugToLabel(slug);
  const lines = [];
  const total = Object.values(bySeries).reduce((n, s) => n + s.quizzes.length, 0);
  lines.push(`CRIPFCnt — ${label}`);
  lines.push(`${total} assessment${total === 1 ? "" : "s"}`);
  lines.push("=".repeat(60));
  lines.push("");

  const seriesKeys = Object.keys(bySeries).sort();
  for (const key of seriesKeys) {
    const s = bySeries[key];
    lines.push(`▸ ${s.seriesLabel}  [${s.level}]  (${s.quizzes.length})`);
    lines.push("-".repeat(60));
    for (const q of s.quizzes) {
      lines.push(`  • ${q.title}   (${q.questionCount}q)`);
      if (WANT_FULL) {
        if (q.passage) {
          lines.push("");
          lines.push("    PASSAGE:");
          for (const p of String(q.passage).split(/\n+/)) lines.push(`    ${p.trim()}`);
        }
        q.questions.forEach((qn, qi) => {
          lines.push("");
          lines.push(`    Q${qi + 1}. ${qn.text}`);
          qn.choices.forEach(ch => {
            const mark = ch.correct ? " ✓" : "";
            lines.push(`       ${ch.label}) ${ch.text}${mark}`);
          });
        });
        lines.push("");
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function esc(str) {
  return String(str || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function renderHtml(slug, bySeries) {
  const label = slugToLabel(slug);
  const total = Object.values(bySeries).reduce((n, s) => n + s.quizzes.length, 0);
  const seriesKeys = Object.keys(bySeries).sort();

  const blocks = seriesKeys.map(key => {
    const s = bySeries[key];
    const quizHtml = s.quizzes.map(q => {
      let body = `<div class="quiz"><div class="qtitle">${esc(q.title)} <span class="badge">${q.questionCount}q</span></div>`;
      if (WANT_FULL && q.passage) {
        body += `<div class="passage">${esc(q.passage).replace(/\n+/g, "<br>")}</div>`;
      }
      if (WANT_FULL && q.questions.length) {
        body += q.questions.map((qn, qi) => {
          const choices = qn.choices.map(ch =>
            `<li class="${ch.correct ? "correct" : ""}">${esc(ch.label)}) ${esc(ch.text)}${ch.correct ? " ✓" : ""}</li>`
          ).join("");
          return `<div class="q"><div class="qq">Q${qi + 1}. ${esc(qn.text)}</div><ol class="ch">${choices}</ol></div>`;
        }).join("");
      }
      body += `</div>`;
      return body;
    }).join("");
    return `<section><h2>${esc(s.seriesLabel)} <small>${s.level} · ${s.quizzes.length}</small></h2>${quizHtml}</section>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>CRIPFCnt — ${esc(label)}</title>
<style>
  :root{--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--accent:#2563eb;--ok:#16a34a}
  *{box-sizing:border-box}
  body{font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);max-width:820px;margin:40px auto;padding:0 24px}
  h1{font-size:26px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 24px}
  section{margin:26px 0} h2{font-size:16px;border-left:4px solid var(--accent);padding-left:10px;margin:0 0 12px}
  h2 small{color:var(--mut);font-weight:500;text-transform:capitalize}
  .quiz{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
  .qtitle{font-weight:600} .badge{background:#eff6ff;color:var(--accent);font-size:12px;padding:2px 8px;border-radius:20px;margin-left:6px}
  .passage{margin:12px 0;padding:12px;background:#f8fafc;border-radius:8px;color:#334155;font-size:14px}
  .q{margin:12px 0} .qq{font-weight:600} .ch{margin:6px 0 0;padding-left:22px} .ch li{margin:2px 0}
  .ch li.correct{color:var(--ok);font-weight:600}
  @media print{body{margin:0;max-width:none}.quiz{break-inside:avoid}}
</style></head><body>
<h1>CRIPFCnt — ${esc(label)}</h1>
<p class="sub">${total} assessment${total === 1 ? "" : "s"}${WANT_FULL ? " · with passages & answers" : ""}</p>
${blocks}
</body></html>`;
}

// ── PDF via puppeteer (reuses your VPS-safe launch flags) ────────────────────
async function renderPdf(html, filepath) {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    console.warn("⚠️  puppeteer not installed — skipping PDF. (npm install puppeteer)");
    return false;
  }
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle2", timeout: 30000 });
    await page.emulateMediaType("print");
    await page.pdf({ path: filepath, format: "A4", printBackground: true, margin: { top: "40px", bottom: "40px", left: "0", right: "0" } });
    return true;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(MONGO_URI);
  const org = await Organization.findOne({ slug: ORG_SLUG }).lean();
  if (!org) throw new Error(`Org not found: ${ORG_SLUG}`);
  const orgId = new mongoose.Types.ObjectId(String(org._id));

  // No category arg → list all areas with counts (like the sidebar) and exit.
  if (!CATEGORY_ARG) {
    const rawCats = await Question.aggregate([
      { $match: { organization: orgId, type: "comprehension", category: { $exists: true, $nin: [null, "", "out-of-scope"] } } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    console.log(`\nProfessional Areas for "${ORG_SLUG}":\n`);
    for (const c of rawCats) {
      console.log(`  ${String(c.count).padStart(4)}  ${slugToLabel(c._id).padEnd(30)} (${c._id})`);
    }
    console.log(`\nRun again with a slug, e.g.:\n  node ${path.basename(process.argv[1])} ${rawCats[0]?._id || "structural-responsibility"} --full\n`);
    await mongoose.disconnect();
    return;
  }

  // Resolve which categories to export.
  let categories;
  if (CATEGORY_ARG === "all") {
    const rawCats = await Question.aggregate([
      { $match: { organization: orgId, type: "comprehension", category: { $exists: true, $nin: [null, "", "out-of-scope"] } } },
      { $group: { _id: "$category", count: { $sum: 1 } } }
    ]);
    categories = rawCats.map(c => c._id);
  } else {
    categories = [CATEGORY_ARG];
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const slug of categories) {
    const bySeries = await loadCategory(orgId, slug);
    const total = Object.values(bySeries).reduce((n, s) => n + s.quizzes.length, 0);
    if (!total) {
      console.log(`⚠️  ${slug}: 0 assessments${WANT_LOOSE ? "" : " (try --loose)"}`);
      continue;
    }

    const base = path.join(OUT_DIR, WANT_FULL ? `${slug}-full` : slug);
    const txt = renderText(slug, bySeries);
    const html = renderHtml(slug, bySeries);

    fs.writeFileSync(`${base}.txt`, txt, "utf8");
    fs.writeFileSync(`${base}.html`, html, "utf8");
    console.log(`✅ ${slug}: ${total} assessments → ${base}.txt / .html`);

    if (WANT_PDF) {
      const ok = await renderPdf(html, `${base}.pdf`);
      if (ok) console.log(`   📄 PDF → ${base}.pdf`);
    }
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch(err => {
  console.error("❌", err && (err.stack || err.message || err));
  process.exit(1);
});