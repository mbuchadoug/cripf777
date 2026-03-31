// scripts/ai-recategorize-clean.js
// ─────────────────────────────────────────────────────────────────────────────
// CONTENT-FIRST RE-CATEGORISATION v4
//
// KEY IMPROVEMENTS:
//  - Batch size = 5 for maximum per-quiz accuracy
//  - System prompt has detailed DISAMBIGUATION EXAMPLES so "governance"
//    is no longer used as a catch-all; each quiz gets its specific category
//  - resolveCategory() validates AI output against allowed list
//  - Full pillar + category breakdown printed after completion for verification
//
// RUN: node scripts/ai-recategorize-clean.js
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import Question from '../models/question.js';
import dotenv from 'dotenv';
dotenv.config();

const ORG_ID     = new mongoose.Types.ObjectId('693b3d8d8004ece0477340c7');
const BATCH_SIZE = 5;

const VALID_PILLARS = [
  'consciousness','responsibility','interpretation','purpose',
  'frequencies','civilization','negotiation','technology','general'
];
const VALID_LEVELS = ['foundation','intermediate','advanced','expert'];

const PILLAR_CATEGORIES = {
  consciousness:  ['consciousness-studies','philosophical-inquiry','systems-thinking','critical-thinking','narrative-framing'],
  responsibility: ['governance','institutional-accountability','public-sector-ethics','rule-of-law','financial-accountability','structural-responsibility','social-contract','responsibility-frameworks'],
  interpretation: ['interpretive-frameworks','language-recalibration','media-literacy','strategic-communication','narrative-framing'],
  purpose:        ['strategic-leadership','change-management','policy-implementation','community-leadership','crisis-management'],
  frequencies:    ['frequencies-and-influence'],
  civilization:   ['civilisation-theory','social-justice','human-rights','economic-justice','environmental-governance','electoral-systems'],
  negotiation:    ['conflict-resolution','negotiation-dynamics'],
  technology:     ['technology-governance','digital-ethics'],
  general:        ['professional-development','education-reform','performance-metrics','institutional-trust','scoi-fundamentals'],
};

const ALL_VALID_CATEGORIES = Object.values(PILLAR_CATEGORIES).flat();

const QUIZ_SYSTEM_PROMPT = `
You are a content analyst for the CRIPFCNT organisational intelligence framework.

CRIPFCNT pillars — pick EXACTLY ONE:
  consciousness | responsibility | interpretation | purpose |
  frequencies | civilization | negotiation | technology | general

ALLOWED CATEGORIES — pick the MOST SPECIFIC one that fits:

  consciousness  → consciousness-studies | philosophical-inquiry | systems-thinking | critical-thinking | narrative-framing
  responsibility → governance | institutional-accountability | public-sector-ethics | rule-of-law | financial-accountability | structural-responsibility | social-contract | responsibility-frameworks
  interpretation → interpretive-frameworks | language-recalibration | media-literacy | strategic-communication | narrative-framing
  purpose        → strategic-leadership | change-management | policy-implementation | community-leadership | crisis-management
  frequencies    → frequencies-and-influence
  civilization   → civilisation-theory | social-justice | human-rights | economic-justice | environmental-governance | electoral-systems
  negotiation    → conflict-resolution | negotiation-dynamics
  technology     → technology-governance | digital-ethics
  general        → professional-development | education-reform | performance-metrics | institutional-trust | scoi-fundamentals

══ DISAMBIGUATION — READ CAREFULLY ══

"governance" = ONLY for content about how governments/institutions are structured,
  constitutional design, separation of powers, cabinet systems, federalism.
  Do NOT use for auditing, ethics, finance, law, or leadership — use the
  specific category for those topics instead.

"institutional-accountability" = oversight of public bodies, anti-corruption
  mechanisms, parliamentary scrutiny, public watchdogs, ombudsman offices,
  audit institutions, accountability frameworks.

"public-sector-ethics" = codes of conduct for officials, conflicts of interest,
  whistleblowing, bribery in public office, professional integrity standards.

"rule-of-law" = constitutional rights, courts, judicial independence, legal
  systems, enforcement of law, due process, constitutionalism.

"financial-accountability" = public finance management, treasury, budget
  oversight, expenditure control, procurement fraud, fiduciary duty,
  misappropriation of public funds, financial reporting.

"structural-responsibility" = how responsibility is transferred, outsourced or
  delegated downward in hierarchies; accountability gaps; blame shifting.

"social-contract" = citizenship obligations, civic duty, legitimacy of
  government, public trust, consent of the governed, social obligations.

"responsibility-frameworks" = frameworks for assigning, measuring, and enforcing
  accountability in organisations; SCOI-related responsibility systems.

"strategic-leadership" = executive vision, CEO decisions, board leadership,
  setting organisational direction, leadership philosophy. Pillar = purpose.

"change-management" = managing transformation, restructuring, reform
  implementation, handling resistance to change. Pillar = purpose.

"policy-implementation" = turning policy into practice, programme delivery,
  monitoring & evaluation of government programmes. Pillar = purpose.

"community-leadership" = local government, grassroots leadership, civic
  engagement, ward-level governance, stakeholder participation.

"crisis-management" = emergency response, disaster management, risk planning,
  organisational continuity, pandemic response.

"consciousness-studies" = awareness, mindfulness, metacognition, self-reflection,
  consciousness as a leadership tool.

"philosophical-inquiry" = ethics, moral philosophy, ontology, epistemology,
  truth, values, virtue ethics.

"systems-thinking" = complexity, feedback loops, emergent behaviour,
  interdependence, holistic analysis.

"interpretive-frameworks" = paradigms, worldviews, analytical lenses,
  how we read situations and construct meaning.

"language-recalibration" = redefining terminology, semantic precision,
  reclaiming words, discourse analysis.

"media-literacy" = evaluating media, misinformation, fake news, editorial bias.

"strategic-communication" = messaging, framing, public relations, narrative
  management, rhetoric for leaders.

"civilisation-theory" = society-building, cultural identity, heritage,
  civilisational progress, nation-state formation.

"social-justice" = equality, discrimination, civil rights, inclusion, oppression,
  marginalised groups.

"human-rights" = universal rights, dignity, freedoms, refugee, torture, asylum.

"electoral-systems" = elections, voting, democracy, ballots, political
  representation, campaign systems.

"economic-justice" = inequality, poverty, redistribution, living wage,
  wealth gaps, social mobility.

"environmental-governance" = climate policy, sustainability governance,
  conservation management.

"technology-governance" = AI policy, data governance, digital regulation,
  platform accountability, tech ethics at policy level.

"digital-ethics" = privacy, surveillance, algorithmic bias, AI ethics at the
  individual/societal level, data protection rights.

══ SCOPE ══

OUT-OF-SCOPE: Pure academic content (maths, algebra, biology, chemistry, physics,
English grammar, geography facts, history dates) with NO governance/leadership/
ethics/society link → set pillar="out-of-scope" and category="out-of-scope".

"general" = absolute last resort for CRIPFCNT content that fits no other pillar.

══ OUTPUT ══

Return a JSON array with one object per quiz. Fields:
1. "id"           — the quiz _id exactly as given
2. "pillar"       — one of the 9 pillars OR "out-of-scope"
3. "category"     — most specific allowed category OR "out-of-scope"
4. "series"       — lowercase-hyphenated learning track (NOT the quiz title).
                    Quizzes on the same theme MUST share the same series slug.
                    Good examples: "governing-with-integrity",
                    "public-finance-accountability", "rule-of-law-foundations",
                    "ethics-in-public-service", "leadership-and-strategy",
                    "consciousness-and-leadership", "electoral-systems-in-practice"
5. "seriesOrder"  — integer 1–10 by complexity within the series
6. "level"        — foundation | intermediate | advanced | expert
7. "title"        — clean professional display title, max 8 words
8. "confidence"   — 0.0 to 1.0

Return ONLY a JSON array. No prose, no markdown, no backtick fences.
[{"id":"<id>","pillar":"responsibility","category":"financial-accountability","series":"public-finance-accountability","seriesOrder":2,"level":"intermediate","title":"Budget Oversight in Public Institutions","confidence":0.96}]
`.trim();

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
      const clean = text.replace(/```json|```/gi, '').trim();
      try   { return JSON.parse(clean); }
      catch { return JSON.parse(clean.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}')); }
    }

    if ([429, 529].includes(res.status)) {
      const wait = attempt * 20_000;
      console.log(`  ⏳ Rate limited (${res.status}), attempt ${attempt}/${retries}, waiting ${wait/1000}s…`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  throw new Error('API overloaded after all retries');
}

function makeSlug(str) {
  return (str || 'general').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function resolveCategory(aiCategory, pillar) {
  const slug = makeSlug(aiCategory || '');
  if (ALL_VALID_CATEGORIES.includes(slug)) return slug;
  // AI went off-list — use first valid category for this pillar
  return (PILLAR_CATEGORIES[pillar] || PILLAR_CATEGORIES.general)[0];
}

async function resetCategorisation() {
  console.log('\n━━━ STEP 0: Resetting all AI categorisation ━━━\n');
  const result = await Question.updateMany(
    { organization: ORG_ID },
    {
      $unset: {
        category: '', categories: '', series: '', seriesOrder: '',
        level: '', quizTitle: '',
        'meta.aiPillar': '', 'meta.aiConfidence': '',
        'meta.aiCategorised': '', 'meta.isOutOfScope': '',
        'meta.inheritedFromQuiz': ''
      }
    }
  );
  console.log(`  Cleared ${result.modifiedCount} documents.\n`);
}

async function categorizeQuizzes(stats) {
  console.log('━━━ STEP 1: Categorising comprehension quizzes (batch size 5) ━━━\n');
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

    if (!quizzes.length) { console.log('  ✅ All quizzes processed.\n'); break; }

    batch++;
    console.log(`  Batch ${batch}: ${quizzes.length} quizzes…`);

    const allChildIds = quizzes.flatMap(q => q.questionIds || []);
    const childDocs   = allChildIds.length
      ? await Question.find({ _id: { $in: allChildIds } }).select('_id text').lean()
      : [];
    const childMap = {};
    for (const c of childDocs) childMap[String(c._id)] = c.text || '';

    const userContent = quizzes.map(q => {
      const title      = (q.text    || '').slice(0, 200);
      const passage    = (q.passage || '').slice(0, 700);
      const childTexts = (q.questionIds || []).slice(0, 10)
        .map((id, i) => `Q${i+1}: ${(childMap[String(id)] || '').slice(0, 150)}`)
        .filter(Boolean).join('\n');
      return [
        `ID: ${q._id}`,
        `TITLE: ${title}`,
        passage    ? `PASSAGE: ${passage}`       : '',
        childTexts ? `QUESTIONS:\n${childTexts}` : ''
      ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');

    try {
      const results   = await callClaude(userContent);
      const resultMap = {};
      for (const r of results) if (r?.id) resultMap[String(r.id)] = r;

      const ops = quizzes.map(q => {
        const r = resultMap[String(q._id)];
        if (!r) return null;

        const isOutOfScope = r.pillar === 'out-of-scope' || r.category === 'out-of-scope';
        const pillar       = VALID_PILLARS.includes(r.pillar) ? r.pillar : 'general';
        const category     = isOutOfScope ? 'out-of-scope' : resolveCategory(r.category, pillar);
        const series       = isOutOfScope ? 'out-of-scope' : makeSlug(r.series || `${pillar}-studies`);
        const seriesOrder  = typeof r.seriesOrder === 'number' ? Math.max(1, Math.min(10, r.seriesOrder)) : 1;
        const level        = VALID_LEVELS.includes(r.level) ? r.level : 'foundation';
        const title        = r.title || (q.text || '').slice(0, 80) || 'Untitled';

        if (isOutOfScope) stats.outOfScope++;
        stats.categorySeen[category] = (stats.categorySeen[category] || 0) + 1;
        stats.seriesSeen[series]     = (stats.seriesSeen[series]     || 0) + 1;
        if (!stats.pillarBreakdown[pillar]) stats.pillarBreakdown[pillar] = {};
        stats.pillarBreakdown[pillar][category] = (stats.pillarBreakdown[pillar][category] || 0) + 1;
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
                'meta.aiConfidence':  r.confidence ?? null,
                'meta.aiCategorised': true,
                'meta.isOutOfScope':  isOutOfScope,
                updatedAt:            new Date()
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
          console.log(`      [${r.pillar}] ${r.category} → "${r.series}" — ${r.title}`)
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

async function propagateToChildren(stats) {
  console.log('━━━ STEP 2: Propagating to child questions ━━━\n');

  const quizzes = await Question.find({
    organization: ORG_ID,
    type: 'comprehension',
    'meta.aiCategorised': true,
    'meta.isOutOfScope': { $ne: true },
    questionIds: { $exists: true, $not: { $size: 0 } }
  }).select('_id series category level meta questionIds').lean();

  console.log(`  ${quizzes.length} parent quizzes to propagate from.`);
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

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB.\n');

  const stats = {
    quizzesModified: 0, propagated: 0,
    errors: 0, outOfScope: 0,
    categorySeen: {}, seriesSeen: {},
    pillarBreakdown: {}
  };

  const total = await Question.countDocuments({ organization: ORG_ID, type: 'comprehension' });
  console.log(`📊 Total comprehension quizzes: ${total}\n`);

  await resetCategorisation();
  await categorizeQuizzes(stats);
  await propagateToChildren(stats);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RE-CATEGORISATION COMPLETE — VERIFY DISTRIBUTION BEFORE GOING LIVE');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Quizzes categorised : ${stats.quizzesModified}`);
  console.log(`  Out-of-scope flagged: ${stats.outOfScope}`);
  console.log(`  Children propagated : ${stats.propagated}`);
  console.log(`  Batch errors        : ${stats.errors}`);
  console.log(`  Unique categories   : ${Object.keys(stats.categorySeen).length}`);
  console.log(`  Unique series       : ${Object.keys(stats.seriesSeen).length}`);

  console.log('\n  ── PER-PILLAR CATEGORY BREAKDOWN ─────────────────────────────');
  for (const pillar of [...VALID_PILLARS, 'out-of-scope']) {
    const cats = stats.pillarBreakdown[pillar];
    if (!cats) continue;
    const tot = Object.values(cats).reduce((s, n) => s + n, 0);
    console.log(`\n  ${pillar.toUpperCase()} (${tot} quizzes):`);
    Object.entries(cats).sort((a, b) => b[1] - a[1])
      .forEach(([cat, n]) => console.log(`    ${String(n).padStart(4)}×  ${cat}`));
  }

  console.log('\n  ── ALL CATEGORIES BY COUNT ───────────────────────────────────');
  Object.entries(stats.categorySeen).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}×  ${k}`));

  console.log('\n  ── OUT-OF-SCOPE QUIZ TITLES ──────────────────────────────────');
  const oos = await Question.find({
    organization: ORG_ID, type: 'comprehension', 'meta.isOutOfScope': true
  }).select('_id text').lean();
  if (oos.length === 0) console.log('    (none)');
  oos.forEach(d => console.log(`    ${d._id}  "${(d.text || '').slice(0, 70)}"`));

  await mongoose.disconnect();
  console.log('\n✅ Done. Review the distribution above before going live.\n');
}

run().catch(e => { console.error(e); process.exit(1); });