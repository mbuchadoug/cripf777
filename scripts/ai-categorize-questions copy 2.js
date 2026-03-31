// scripts/ai-recategorize-clean.js
// ─────────────────────────────────────────────────────────────────────────────
// CONTENT-FIRST RE-CATEGORISATION
// Ignores all existing category/module/series fields.
// Judges ONLY from passage text + sub-question texts.
// Flags out-of-scope content (maths, science, etc.) rather than
// forcing it into a CRIPFCNT pillar.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import Question from '../models/question.js';
import dotenv from 'dotenv';
dotenv.config();

const ORG_ID    = new mongoose.Types.ObjectId('693b3d8d8004ece0477340c7');
const BATCH_SIZE = 15;   // smaller — we're sending more text per quiz

const VALID_PILLARS = [
  'consciousness','responsibility','interpretation','purpose',
  'frequencies','civilization','negotiation','technology','general'
];
const VALID_LEVELS  = ['foundation','intermediate','advanced','expert'];

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────
// Critical change: we send passage + sub-questions, and explicitly tell
// the model to ignore any prior metadata.
const QUIZ_SYSTEM_PROMPT = `
You are a content analyst for the CRIPFCNT organisational intelligence framework.

CRIPFCNT pillars (you MUST pick exactly one):
  consciousness | responsibility | interpretation | purpose |
  frequencies | civilization | negotiation | technology | general

YOUR TASK:
Read the quiz passage and its comprehension questions carefully.
Classify the quiz based ONLY on what the text is actually about.
IGNORE any existing category, module, or series label — treat the text as if you are seeing it for the first time.

IMPORTANT RULES:
1. If the passage is a high-school or university academic subject
   (mathematics, algebra, geometry, calculus, biology, chemistry, physics,
   English grammar, literature analysis, geography facts, history dates)
   that has NO connection to governance, leadership, ethics, or society —
   set pillar="out-of-scope" and category="out-of-scope".
   
2. Only assign a CRIPFCNT pillar if the text genuinely addresses
   organisational, societal, governance, leadership, philosophical,
   technological-ethics, or civilisational themes.

3. "general" pillar = LAST RESORT only, when content is clearly
   CRIPFCNT-related but does not fit the other 8.

For each quiz return:

1. "pillar" — one of the 9 pillars above, OR "out-of-scope"
2. "category" — specific professional domain in lowercase-hyphenated format.
   Examples: "institutional-accountability", "governance-reform",
   "digital-ethics", "frequencies-of-influence", "strategic-leadership"
   If out-of-scope: "out-of-scope"
3. "series" — named learning track, lowercase-hyphenated.
   Examples: "governing-with-purpose", "accountability-in-practice",
   "consciousness-and-leadership", "technology-and-society"
   If out-of-scope: "out-of-scope"
4. "seriesOrder" — integer 1-10 (position within series by complexity)
5. "level" — foundation | intermediate | advanced | expert
6. "title" — clean professional display title ≤8 words
7. "confidence" — 0.0 to 1.0

Return ONLY a JSON array. No prose. No markdown. No backticks.
[{"id":"<id>","pillar":"responsibility","category":"institutional-accountability","series":"accountability-in-practice","seriesOrder":1,"level":"intermediate","title":"Accountability in Public Institutions","confidence":0.91}]
`.trim();

// ─── API CALL WITH RETRY ─────────────────────────────────────────────────────
async function callClaude(userContent, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: QUIZ_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (res.ok) {
      const data  = await res.json();
      const text  = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const clean = text.replace(/```json|```/g, '').trim();
      try   { return JSON.parse(clean); }
      catch { return JSON.parse(clean.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}')); }
    }

    if ([429, 529].includes(res.status)) {
      const wait = attempt * 20_000;
      console.log(`  ⏳ API busy (${res.status}), attempt ${attempt}/${retries} — waiting ${wait/1000}s…`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  throw new Error('API still overloaded after all retries');
}

function slug(str) {
  return (str || 'general').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ─── STEP 1: RESET all existing AI categorisation ───────────────────────────
async function resetCategorisation() {
  console.log('\n━━━ STEP 0: Resetting existing AI categorisation ━━━\n');
  const result = await Question.updateMany(
    { organization: ORG_ID, 'meta.aiCategorised': true },
    {
      $unset: {
        category:              '',
        categories:            '',
        series:                '',
        seriesOrder:           '',
        level:                 '',
        quizTitle:             '',
        'meta.aiPillar':       '',
        'meta.aiConfidence':   '',
        'meta.aiCategorised':  '',
        'meta.inheritedFromQuiz': ''
      }
    }
  );
  console.log(`  Cleared ${result.modifiedCount} documents.\n`);
}

// ─── STEP 2: Categorise comprehension quizzes ────────────────────────────────
// For each quiz we send: passage (600 chars) + up to 8 sub-question texts.
// This gives the model the ACTUAL content, not just a title.
async function categorizeQuizzes(stats) {
  console.log('━━━ STEP 1: Categorising comprehension quizzes ━━━\n');

  let skip = 0, batch = 0;
  while (true) {
    const quizzes = await Question.find({
      organization: ORG_ID,
      type: 'comprehension',
      'meta.aiCategorised': { $ne: true }
    })
      .select('_id text passage module questionIds')
      .limit(BATCH_SIZE)
      .skip(skip)
      .lean();

    if (!quizzes.length) { console.log('  ✅ All quizzes done.\n'); break; }

    batch++;
    console.log(`  Batch ${batch}: ${quizzes.length} quizzes…`);

    // Fetch sub-question texts for richer context
    const allChildIds = quizzes.flatMap(q => q.questionIds || []);
    const childDocs   = allChildIds.length
      ? await Question.find({ _id: { $in: allChildIds } }).select('_id text').lean()
      : [];
    const childMap = {};
    for (const c of childDocs) childMap[String(c._id)] = c.text || '';

    const userContent = quizzes.map(q => {
      const passage   = q.passage  ? q.passage.slice(0, 600)  : '';
      const title     = q.text     ? q.text.slice(0, 200)     : '';
      const childTexts = (q.questionIds || []).slice(0, 8)
        .map((id, i) => `Q${i+1}: ${(childMap[String(id)] || '').slice(0, 120)}`)
        .filter(Boolean)
        .join('\n');

      return [
        `ID: ${q._id}`,
        `TITLE: ${title}`,
        passage ? `PASSAGE: ${passage}` : '',
        childTexts ? `QUESTIONS:\n${childTexts}` : ''
      ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');

    try {
      const results  = await callClaude(userContent);
      const resultMap = {};
      for (const r of results) if (r?.id) resultMap[String(r.id)] = r;

      const ops = quizzes.map(q => {
        const r = resultMap[String(q._id)];
        if (!r) return null;

        const isOutOfScope = r.pillar === 'out-of-scope' || r.category === 'out-of-scope';
        const pillar       = VALID_PILLARS.includes(r.pillar) ? r.pillar : 'general';
        const category     = isOutOfScope ? 'out-of-scope' : slug(r.category || 'general');
        const series       = isOutOfScope ? 'out-of-scope' : slug(r.series   || pillar);
        const seriesOrder  = typeof r.seriesOrder === 'number' ? r.seriesOrder : 1;
        const level        = VALID_LEVELS.includes(r.level) ? r.level : 'foundation';
        const title        = r.title || q.text?.slice(0, 80) || 'Untitled';

        if (isOutOfScope) stats.outOfScope++;
        stats.categorySeen[category] = (stats.categorySeen[category] || 0) + 1;
        stats.seriesSeen[series]     = (stats.seriesSeen[series]     || 0) + 1;
        stats.quizzesModified++;

        return {
          updateOne: {
            filter: { _id: q._id },
            update: {
              $set: {
                category, categories: [category],
                series, seriesOrder, level,
                quizTitle: title,
                'meta.aiPillar':      pillar,
                'meta.aiConfidence':  r.confidence ?? null,
                'meta.aiCategorised': true,
                'meta.isOutOfScope':  isOutOfScope,
                updatedAt: new Date()
              }
            }
          }
        };
      }).filter(Boolean);

      if (ops.length) {
        await Question.bulkWrite(ops);
        const avgConf = (results.reduce((s, r) => s + (r?.confidence || 0), 0) / results.length).toFixed(2);
        console.log(`    ✓ ${ops.length} written | avg confidence: ${avgConf}`);
        results.slice(0, 3).forEach(r =>
          console.log(`      [${r.pillar}] "${r.title}" → ${r.series}`)
        );
      }

      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`    ✗ Batch ${batch} failed:`, err.message);
      stats.errors++;
      skip += BATCH_SIZE;
      continue;
    }

    skip += BATCH_SIZE;
  }
}

// ─── STEP 3: Propagate to child questions ────────────────────────────────────
async function propagateToChildren(stats) {
  console.log('━━━ STEP 2: Propagating to child questions ━━━\n');

  const quizzes = await Question.find({
    organization: ORG_ID,
    type: 'comprehension',
    'meta.aiCategorised': true,
    'meta.isOutOfScope': { $ne: true },   // don't propagate out-of-scope
    questionIds: { $exists: true, $not: { $size: 0 } }
  }).select('_id series category level meta questionIds').lean();

  console.log(`  ${quizzes.length} quizzes to propagate from.`);
  let propagated = 0;

  for (const quiz of quizzes) {
    if (!quiz.questionIds?.length) continue;
    const result = await Question.updateMany(
      { _id: { $in: quiz.questionIds } },
      {
        $set: {
          series:                   quiz.series,
          category:                 quiz.category,
          level:                    quiz.level || 'foundation',
          'meta.aiPillar':          quiz.meta?.aiPillar || 'general',
          'meta.inheritedFromQuiz': quiz._id,
          updatedAt:                new Date()
        }
      }
    );
    propagated += result.modifiedCount;
  }

  stats.propagated = propagated;
  console.log(`  ✅ Propagated to ${propagated} child questions.\n`);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected.\n');

  const stats = {
    quizzesModified: 0, propagated: 0,
    errors: 0, outOfScope: 0,
    categorySeen: {}, seriesSeen: {}
  };

  const total = await Question.countDocuments({
    organization: ORG_ID, type: 'comprehension'
  });
  console.log(`📊 Total comprehension quizzes to process: ${total}\n`);

  await resetCategorisation();
  await categorizeQuizzes(stats);
  await propagateToChildren(stats);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  RE-CATEGORISATION COMPLETE');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Quizzes categorised : ${stats.quizzesModified}`);
  console.log(`  Out-of-scope flagged: ${stats.outOfScope}`);
  console.log(`  Children propagated : ${stats.propagated}`);
  console.log(`  Batch errors        : ${stats.errors}`);
  console.log(`  Unique categories   : ${Object.keys(stats.categorySeen).length}`);
  console.log(`  Unique series       : ${Object.keys(stats.seriesSeen).length}`);

  console.log('\n  Top 20 categories:');
  Object.entries(stats.categorySeen)
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}×  ${k}`));

  console.log('\n  Out-of-scope quizzes (review these):');
  const outOfScopeDocs = await Question.find({
    organization: ORG_ID, type: 'comprehension',
    'meta.isOutOfScope': true
  }).select('_id text').lean();
  outOfScopeDocs.forEach(d => console.log(`    ${d._id}  ${d.text?.slice(0, 60)}`));

  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });