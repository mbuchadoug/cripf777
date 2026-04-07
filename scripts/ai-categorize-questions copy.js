// scripts/ai-categorize-questions.js
import mongoose from 'mongoose';
import Question from '../models/question.js';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY is not set. Check your .env file.');
  process.exit(1);
}
console.log('✅ API key loaded:', process.env.ANTHROPIC_API_KEY.slice(0, 15) + '...\n');

const BATCH_SIZE = 20;
const ORG_ID = new mongoose.Types.ObjectId('693b3d8d8004ece0477340c7');

const VALID_PILLARS = [
  'consciousness', 'responsibility', 'interpretation', 'purpose',
  'frequencies', 'civilization', 'negotiation', 'technology', 'general'
];

const QUESTION_SYSTEM_PROMPT = `You are a categorization engine for the CRIPFCNT framework - an organizational intelligence and transformation methodology.

CRIPFCNT pillars (FIXED - always pick from this exact list only):
  consciousness | responsibility | interpretation | purpose |
  frequencies | civilization | negotiation | technology | general

For each question assign:

1. "pillar" - the CRIPFCNT pillar. MUST be one of the 9 values above, no exceptions.

2. "category" - the specific professional domain or subject this question addresses.
   Be SPECIFIC. Use the question's actual content to decide.
   Use lowercase-hyphenated format. 2–3 words ideal.
   Examples: "institutional-accountability", "language-recalibration",
   "civic-consciousness", "strategic-communication", "public-sector-ethics",
   "social-contract", "governance-reform", "digital-ethics", "media-literacy",
   "community-leadership", "economic-justice", "conflict-resolution"

3. "series" - a named learning track this question belongs to.
   Name it based on what the question is teaching. Be meaningful and descriptive.
   If multiple questions share a theme, give them the SAME series name.
   Use lowercase-hyphenated format.
   Examples: "language-and-recalibration", "governing-with-purpose",
   "accountability-in-practice", "conscious-leadership", "civilisation-and-society",
   "frequencies-of-influence", "negotiating-change", "technology-and-governance"

4. "confidence" - 0.0 to 1.0

Return ONLY a valid JSON array. No prose, no markdown, no backticks.
[{"id":"<id>","pillar":"responsibility","category":"institutional-accountability","series":"accountability-in-practice","confidence":0.93}]`;

const QUIZ_SYSTEM_PROMPT = `You are a categorization engine for the CRIPFCNT framework - an organizational intelligence and transformation methodology.

CRIPFCNT pillars (FIXED - always pick from this exact list only):
  consciousness | responsibility | interpretation | purpose |
  frequencies | civilization | negotiation | technology | general

You are categorizing QUIZZES - each quiz is a passage or comprehension piece that contains multiple questions. The "text" field is the quiz title or passage opening.

For each quiz assign:

1. "pillar" - the primary CRIPFCNT pillar. MUST be one of the 9 values above.

2. "category" - the specific professional domain this quiz addresses.
   Be SPECIFIC and grounded in the quiz content.
   Use lowercase-hyphenated format. 2–3 words ideal.

3. "series" - the learning series or course track this quiz belongs to.
   Think of it as a course name. Be descriptive and meaningful.
   Quizzes covering related themes should share the same series name.
   Use lowercase-hyphenated format.

4. "seriesOrder" - an integer (1, 2, 3...) suggesting where this quiz sits within
   its series based on complexity or logical progression. Use 1 if unsure.

5. "level" - the difficulty/depth level:
   foundation | intermediate | advanced | expert

6. "title" - a clean, professional display title for this quiz. Max 8 words.

7. "confidence" - 0.0 to 1.0

Return ONLY a valid JSON array. No prose, no markdown, no backticks.
[{"id":"<id>","pillar":"responsibility","category":"institutional-accountability","series":"accountability-in-practice","seriesOrder":1,"level":"intermediate","title":"Accountability in Public Institutions","confidence":0.91}]`;

// ─────────────────────────────────────────────────────────────────────────────
// API CALL WITH AUTOMATIC RETRY ON OVERLOAD
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userContent, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (response.ok) {
      const data = await response.json();
      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const clean = text.replace(/```json|```/g, '').trim();
      try {
        return JSON.parse(clean);
      } catch (e) {
        const repaired = clean.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
        return JSON.parse(repaired);
      }
    }

    const errText = await response.text();

    // Overloaded (529) or rate limited (429) - wait and retry
    if (response.status === 529 || response.status === 429) {
      const wait = attempt * 15000; // 15s, 30s, 45s, 60s, 75s, 90s
      console.log(`    ⏳ API busy (${response.status}), attempt ${attempt}/${retries} - waiting ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    // Any other error - throw immediately
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  throw new Error(`API still overloaded after ${retries} attempts - skipping batch`);
}

function normaliseSlug(str) {
  return (str || 'general').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 1 - Individual questions
// ─────────────────────────────────────────────────────────────────────────────
async function categorizeQuestions(stats) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PASS 1: Categorizing individual questions');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let skip = 0;
  let batchNumber = 0;

  while (true) {
    const questions = await Question.find({
      organization: ORG_ID,
      type: { $ne: 'comprehension' },
      $or: [
        { category: { $exists: false } },
        { category: null },
        { category: 'general' }
      ]
    })
      .select('_id text module modules')
      .limit(BATCH_SIZE)
      .skip(skip)
      .lean();

    if (!questions.length) {
      console.log('  ✅ All questions categorized.\n');
      break;
    }

    batchNumber++;
    console.log(`  Batch ${batchNumber}: processing ${questions.length} questions...`);

    try {
      const userContent = questions.map(q =>
        `ID: ${q._id}\nModule: ${q.module || 'general'}\nText: ${q.text}`
      ).join('\n\n---\n\n');

      const results = await callClaude(QUESTION_SYSTEM_PROMPT, userContent);
      const resultMap = {};
      for (const r of results) if (r?.id) resultMap[String(r.id)] = r;

      const ops = questions.map(q => {
        const r = resultMap[String(q._id)];
        if (!r) return null;

        const pillar   = VALID_PILLARS.includes(r.pillar) ? r.pillar : (q.module || 'general');
        const category = normaliseSlug(r.category);
        const series   = normaliseSlug(r.series);

        stats.categorySeen[category] = (stats.categorySeen[category] || 0) + 1;
        stats.seriesSeen[series]     = (stats.seriesSeen[series]     || 0) + 1;

        return {
          updateOne: {
            filter: { _id: q._id },
            update: {
              $set: {
                category,
                categories:           [category],
                series,
                'meta.aiPillar':      pillar,
                'meta.aiConfidence':  r.confidence || null,
                'meta.aiCategorised': true,
                updatedAt:            new Date()
              }
            }
          }
        };
      }).filter(Boolean);

      if (ops.length) {
        const result = await Question.bulkWrite(ops);
        stats.questionsModified += result.modifiedCount;
        const avgConf = (results.reduce((s, r) => s + (r?.confidence || 0), 0) / results.length).toFixed(2);
        console.log(`    ✓ Modified: ${result.modifiedCount} | Confidence: ${avgConf}`);
        results.slice(0, 2).forEach(r =>
          console.log(`      [${r.pillar}] ${r.category} → ${r.series}`)
        );
      }

      // 3 second pause between batches to avoid hammering the API
      await new Promise(r => setTimeout(r, 3000));

    } catch (err) {
      console.error(`    ✗ Batch ${batchNumber} failed:`, err.message);
      stats.questionErrors++;
      skip += BATCH_SIZE;
      continue;
    }

    skip += BATCH_SIZE;
    console.log(`  Running total: ${stats.questionsModified} modified | ${stats.questionErrors} failed\n`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 2 - Quizzes (comprehension parents)
// ─────────────────────────────────────────────────────────────────────────────
async function categorizeQuizzes(stats) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PASS 2: Categorizing quizzes (comprehension parents)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let skip = 0;
  let batchNumber = 0;

  while (true) {
    const quizzes = await Question.find({
      organization: ORG_ID,
      type: 'comprehension',
      $or: [
        { category: { $exists: false } },
        { category: null },
        { category: 'general' }
      ]
    })
      .select('_id text passage module modules questionIds')
      .limit(BATCH_SIZE)
      .skip(skip)
      .lean();

    if (!quizzes.length) {
      console.log('  ✅ All quizzes categorized.\n');
      break;
    }

    batchNumber++;
    console.log(`  Batch ${batchNumber}: processing ${quizzes.length} quizzes...`);

    try {
      const userContent = quizzes.map(q => {
        const passageSnippet = q.passage
          ? `\nPassage excerpt: ${q.passage.slice(0, 300)}...`
          : '';
        return `ID: ${q._id}\nModule: ${q.module || 'general'}\nTitle/Text: ${q.text}${passageSnippet}`;
      }).join('\n\n---\n\n');

      const results = await callClaude(QUIZ_SYSTEM_PROMPT, userContent);
      const resultMap = {};
      for (const r of results) if (r?.id) resultMap[String(r.id)] = r;

      const VALID_LEVELS = ['foundation', 'intermediate', 'advanced', 'expert'];

      const ops = quizzes.map(q => {
        const r = resultMap[String(q._id)];
        if (!r) return null;

        const pillar      = VALID_PILLARS.includes(r.pillar) ? r.pillar : (q.module || 'general');
        const category    = normaliseSlug(r.category);
        const series      = normaliseSlug(r.series);
        const seriesOrder = typeof r.seriesOrder === 'number' ? r.seriesOrder : 1;
        const level       = VALID_LEVELS.includes(r.level) ? r.level : 'foundation';
        const title       = r.title || q.text?.slice(0, 80) || 'Untitled Quiz';

        stats.categorySeen[category] = (stats.categorySeen[category] || 0) + 1;
        stats.seriesSeen[series]     = (stats.seriesSeen[series]     || 0) + 1;
        stats.quizzesModified++;

        return {
          updateOne: {
            filter: { _id: q._id },
            update: {
              $set: {
                category,
                categories:           [category],
                series,
                seriesOrder,
                level,
                quizTitle:            title,
                'meta.aiPillar':      pillar,
                'meta.aiConfidence':  r.confidence || null,
                'meta.aiCategorised': true,
                updatedAt:            new Date()
              }
            }
          }
        };
      }).filter(Boolean);

      if (ops.length) {
        await Question.bulkWrite(ops);
        const avgConf = (results.reduce((s, r) => s + (r?.confidence || 0), 0) / results.length).toFixed(2);
        console.log(`    ✓ Modified: ${ops.length} | Confidence: ${avgConf}`);
        results.slice(0, 2).forEach(r =>
          console.log(`      [${r.pillar}] "${r.title}" → ${r.series} (${r.level})`)
        );
      }

      await new Promise(r => setTimeout(r, 3000));

    } catch (err) {
      console.error(`    ✗ Batch ${batchNumber} failed:`, err.message);
      stats.quizErrors++;
      skip += BATCH_SIZE;
      continue;
    }

    skip += BATCH_SIZE;
    console.log(`  Running total: ${stats.quizzesModified} modified | ${stats.quizErrors} failed\n`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASS 3 - Propagate quiz series/category down to child questions
// ─────────────────────────────────────────────────────────────────────────────
async function propagateQuizCategoriesToChildren(stats) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PASS 3: Propagating quiz series to child questions');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const quizzes = await Question.find({
    organization: ORG_ID,
    type: 'comprehension',
    'meta.aiCategorised': true,
    questionIds: { $exists: true, $not: { $size: 0 } }
  })
    .select('_id series category level questionIds')
    .lean();

  console.log(`  Found ${quizzes.length} quizzes with child questions.`);

  let propagated = 0;
  for (const quiz of quizzes) {
    if (!quiz.questionIds?.length) continue;

    const result = await Question.updateMany(
      {
        _id: { $in: quiz.questionIds },
        $or: [
          { series: { $exists: false } },
          { series: null },
          { series: 'foundation-series' }
        ]
      },
      {
        $set: {
          series:                   quiz.series,
          level:                    quiz.level || 'foundation',
          category:                 quiz.category,
          'meta.inheritedFromQuiz': quiz._id,
          updatedAt:                new Date()
        }
      }
    );
    propagated += result.modifiedCount;
  }

  stats.propagated = propagated;
  console.log(`  ✅ Propagated series to ${propagated} child questions.\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB.\n');

  const stats = {
    questionsModified: 0,
    quizzesModified:   0,
    questionErrors:    0,
    quizErrors:        0,
    propagated:        0,
    categorySeen:      {},
    seriesSeen:        {}
  };

  const totalQuestions = await Question.countDocuments({
    organization: ORG_ID,
    type: { $ne: 'comprehension' },
    $or: [{ category: { $exists: false } }, { category: null }, { category: 'general' }]
  });
  const totalQuizzes = await Question.countDocuments({
    organization: ORG_ID,
    type: 'comprehension',
    $or: [{ category: { $exists: false } }, { category: null }, { category: 'general' }]
  });

  console.log(`📊 Uncategorized questions : ${totalQuestions}`);
  console.log(`📊 Uncategorized quizzes   : ${totalQuizzes}`);
  console.log(`📊 Total to process        : ${totalQuestions + totalQuizzes}\n`);

  await categorizeQuestions(stats);
  await categorizeQuizzes(stats);
  await propagateQuizCategoriesToChildren(stats);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  CATEGORIZATION COMPLETE');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Questions categorized    : ${stats.questionsModified}`);
  console.log(`  Quizzes categorized      : ${stats.quizzesModified}`);
  console.log(`  Children inherited series: ${stats.propagated}`);
  console.log(`  Question batch errors    : ${stats.questionErrors}`);
  console.log(`  Quiz batch errors        : ${stats.quizErrors}`);
  console.log(`  Unique categories created: ${Object.keys(stats.categorySeen).length}`);
  console.log(`  Unique series created    : ${Object.keys(stats.seriesSeen).length}`);

  console.log('\n  Top 20 categories:');
  Object.entries(stats.categorySeen)
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}x  ${k}`));

  console.log('\n  Top 20 series:');
  Object.entries(stats.seriesSeen)
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}x  ${k}`));

  console.log('\n═══════════════════════════════════════════════════\n');
  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });