// scripts/ai-recategorize-clean.js
// ─────────────────────────────────────────────────────────────────────────────
// CONTENT-FIRST RE-CATEGORISATION v6
//
// CHANGES FROM v5:
//  - Includes existing quizTitle + tags + module hints in prompt for richer signal
//  - Improved series de-duplication: merges slug variants so the same topic
//    doesn't appear as 3 separate series (e.g. "governance-series",
//    "governance-foundations", "governance-1" → "governance-foundations")
//  - New --report-only flag: query DB and print category/pillar breakdown
//    with zero-count warnings — NO API calls, NO DB writes
//  - Admin review JSON export: writes review/low-confidence-items.json on run
//  - Confidence threshold configurable via CONFIDENCE_THRESHOLD env var (default 0.6)
//  - All other v5 safeguards preserved:
//      • --dry-run mode
//      • meta.manualOverride protection
//      • idempotent (re-run safe)
//      • batch size 5
//
// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
//   # Step 1 — dry-run (no DB writes, shows what WOULD happen):
//   node scripts/ai-recategorize-clean.js --dry-run
//
//   # Step 2 — live run (writes to DB):
//   node scripts/ai-recategorize-clean.js
//
//   # Step 3 — report only (reads DB, no API calls):
//   node scripts/ai-recategorize-clean.js --report-only
//
// ─────────────────────────────────────────────────────────────────────────────
// ROLLBACK (emergency — restores state before script ran)
// ─────────────────────────────────────────────────────────────────────────────
//   db.questions.updateMany(
//     { "meta.aiCategorised": true, "meta.manualOverride": { $ne: true } },
//     { $unset: { category:"", categories:"", series:"", seriesOrder:"",
//                 level:"", quizTitle:"", "meta.aiPillar":"",
//                 "meta.aiConfidence":"", "meta.aiCategorised":"",
//                 "meta.isOutOfScope":"", "meta.inheritedFromQuiz":"" } }
//   )
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import fs       from 'fs';
import path     from 'path';
import Question from '../models/question.js';
import dotenv   from 'dotenv';
dotenv.config();

// ── Configuration ─────────────────────────────────────────────────────────────
const ORG_ID     = new mongoose.Types.ObjectId(
  process.env.CRIPFCNT_ORG_ID || '693b3d8d8004ece0477340c7'
);
const BATCH_SIZE          = 5;
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.6');
const REVIEW_OUTPUT_DIR   = path.resolve('review');

// ── 8 CRIPFCNT Pillars ────────────────────────────────────────────────────────
const VALID_PILLARS = [
  'consciousness',
  'responsibility',
  'interpretation',
  'purpose',
  'frequencies',
  'civilization',
  'negotiation',
  'technology'
];

const VALID_LEVELS = ['foundation', 'intermediate', 'advanced', 'expert'];

// ── Category taxonomy ─────────────────────────────────────────────────────────
// Each category maps to ONE primary pillar.
// "governance" = constitutional/structural design only (NOT a catch-all).
const PILLAR_CATEGORIES = {
  consciousness: [
    'consciousness-studies',       // awareness, mindfulness, metacognition
    'philosophical-inquiry',       // ethics, moral philosophy, ontology, epistemology
    'systems-thinking',            // complexity, feedback loops, interdependence
    'critical-thinking',           // reasoning, logic, evidence evaluation
    'psychology',                  // behavioural science, cognition, motivation
    'education',                   // pedagogy, curriculum, learning theory
    'communication',               // interpersonal, rhetoric, discourse
  ],
  responsibility: [
    'governance',                  // constitutional design, separation of powers, cabinet systems
    'institutional-accountability',// oversight, anti-corruption, parliamentary scrutiny
    'public-sector-ethics',        // codes of conduct, whistleblowing, conflicts of interest
    'rule-of-law',                 // constitutional rights, judicial systems, due process
    'financial-accountability',    // public finance, treasury, budget oversight, procurement
    'structural-responsibility',   // how responsibility is transferred/outsourced in hierarchies
    'social-contract',             // citizenship obligations, civic duty, legitimacy
    'administration',              // public administration, civil service management, bureaucracy
  ],
  interpretation: [
    'interpretive-frameworks',     // paradigms, worldviews, analytical lenses
    'language-recalibration',      // redefining terminology, semantic precision
    'media-literacy',              // evaluating media, misinformation, fake news
    'strategic-communication',     // messaging, framing, PR, narrative management
    'narrative-framing',           // agenda-setting, propaganda, spin
    'research-methodology',        // data interpretation, qualitative/quantitative analysis
  ],
  purpose: [
    'strategic-leadership',        // executive vision, board leadership
    'change-management',           // transformation, restructuring, reform
    'policy-implementation',       // turning policy into practice, M&E
    'community-leadership',        // local government, grassroots leadership
    'crisis-management',           // emergency response, disaster management
    'motivation',                  // intrinsic/extrinsic motivation, performance psychology
    'organisational-development',  // org culture, capacity building
    'human-resources',             // HR management, talent, workforce
  ],
  frequencies: [
    'frequencies-and-influence',   // structural signals, resonance, systemic prompts
    'social-development',          // community development, social cohesion
    'institutional-reform',        // systemic change, reform architecture
    'performance-metrics',         // KPIs, SCOI, measurement frameworks
  ],
  civilization: [
    'civilisation-theory',         // society-building, cultural identity, nation-state
    'social-justice',              // equality, discrimination, civil rights
    'human-rights',                // universal rights, dignity, freedoms
    'economic-justice',            // inequality, poverty, redistribution
    'environmental-governance',    // climate policy, sustainability governance
    'electoral-systems',           // elections, voting, democracy
    'public-policy',               // policy design, legislation, regulation
    'law',                         // legal systems, statutes, jurisprudence
  ],
  negotiation: [
    'conflict-resolution',         // mediation, peace, reconciliation
    'negotiation-dynamics',        // bargaining, leverage, concession
    'diplomacy',                   // international relations, treaties
    'finance',                     // financial systems, investment, capital markets
    'strategy',                    // strategic planning, competitive strategy
  ],
  technology: [
    'technology-governance',       // AI policy, data governance, digital regulation
    'digital-ethics',              // privacy, surveillance, algorithmic bias
    'ai-governance',               // AI regulation, model governance, responsible AI
    'risk-and-compliance',         // enterprise risk, regulatory compliance, audit
    'innovation',                  // tech innovation, R&D policy, startup ecosystems
  ],
};

const ALL_VALID_CATEGORIES = Object.values(PILLAR_CATEGORIES).flat();

// Reverse map: category slug → owning pillar
const CATEGORY_TO_PILLAR = {};
for (const [pillar, cats] of Object.entries(PILLAR_CATEGORIES)) {
  for (const cat of cats) CATEGORY_TO_PILLAR[cat] = pillar;
}

// ── System prompt for Claude ──────────────────────────────────────────────────
const QUIZ_SYSTEM_PROMPT = `
You are a content analyst for the CRIPFCNT organisational intelligence framework.

CRIPFCNT has EXACTLY 8 pillars — pick ONE:
  consciousness | responsibility | interpretation | purpose |
  frequencies | civilization | negotiation | technology

══ PILLAR → ALLOWED CATEGORIES ══

consciousness →
  consciousness-studies | philosophical-inquiry | systems-thinking |
  critical-thinking | psychology | education | communication

responsibility →
  governance | institutional-accountability | public-sector-ethics |
  rule-of-law | financial-accountability | structural-responsibility |
  social-contract | administration

interpretation →
  interpretive-frameworks | language-recalibration | media-literacy |
  strategic-communication | narrative-framing | research-methodology

purpose →
  strategic-leadership | change-management | policy-implementation |
  community-leadership | crisis-management | motivation |
  organisational-development | human-resources

frequencies →
  frequencies-and-influence | social-development | institutional-reform |
  performance-metrics

civilization →
  civilisation-theory | social-justice | human-rights | economic-justice |
  environmental-governance | electoral-systems | public-policy | law

negotiation →
  conflict-resolution | negotiation-dynamics | diplomacy | finance | strategy

technology →
  technology-governance | digital-ethics | ai-governance |
  risk-and-compliance | innovation

══ DISAMBIGUATION — READ CAREFULLY ══

"governance" = ONLY for content about how governments/institutions are
  constitutionally structured: separation of powers, cabinet systems,
  federalism, parliamentary design. NOT for auditing, ethics, finance,
  leadership, or law — use the specific category for those.

"institutional-accountability" = oversight of public bodies, anti-corruption
  mechanisms, parliamentary scrutiny, public watchdogs, ombudsman offices,
  audit institutions, accountability frameworks.

"public-sector-ethics" = codes of conduct for officials, conflicts of
  interest, whistleblowing, bribery in public office, integrity standards.

"rule-of-law" = constitutional rights, courts, judicial independence, legal
  systems, enforcement of law, due process, constitutionalism.

"financial-accountability" = public finance management, treasury, budget
  oversight, expenditure control, procurement fraud, fiduciary duty,
  misappropriation of public funds, financial reporting. Pillar = responsibility.

"finance" = financial systems, investment, capital markets, banking, economic
  policy analysis, macroeconomics. Pillar = negotiation.

"law" = statutes, jurisprudence, comparative law, legal analysis, international
  law, commercial law — NOT constitutional/judicial (that is rule-of-law).
  Pillar = civilization.

"public-policy" = policy design, legislation, regulation, regulatory frameworks,
  policy analysis, comparative policy. Pillar = civilization.

"structural-responsibility" = how responsibility is transferred, outsourced or
  delegated downward in hierarchies; accountability gaps; blame shifting.

"social-contract" = citizenship obligations, civic duty, legitimacy of
  government, public trust, consent of the governed.

"administration" = public administration, civil service management,
  bureaucratic systems, government operations. Pillar = responsibility.

"strategic-leadership" = executive vision, CEO decisions, board leadership,
  setting organisational direction, leadership philosophy. Pillar = purpose.

"change-management" = managing transformation, restructuring, reform
  implementation, handling resistance. Pillar = purpose.

"policy-implementation" = turning policy into practice, programme delivery,
  monitoring & evaluation. Pillar = purpose.

"human-resources" = HR management, talent acquisition, workforce planning,
  people management, employment relations. Pillar = purpose.

"organisational-development" = org culture, institutional capacity building,
  structural reform, change architecture. Pillar = purpose.

"motivation" = motivational theory, performance psychology, intrinsic/extrinsic
  incentives, behavioural drivers. Pillar = purpose.

"community-leadership" = local government, grassroots leadership, civic
  engagement, ward-level governance, stakeholder participation.

"crisis-management" = emergency response, disaster management, risk planning,
  organisational continuity, pandemic response.

"consciousness-studies" = awareness, mindfulness, metacognition, self-reflection.
  Pillar = consciousness.

"psychology" = behavioural science, cognitive psychology, social psychology,
  motivation science, decision-making psychology. Pillar = consciousness.

"education" = pedagogy, curriculum design, learning theory, education reform.
  Pillar = consciousness.

"communication" = interpersonal communication, rhetoric, presentation,
  discourse, professional communication. Pillar = consciousness.

"philosophical-inquiry" = ethics, moral philosophy, ontology, epistemology,
  truth, values, virtue ethics. Pillar = consciousness.

"systems-thinking" = complexity, feedback loops, emergent behaviour,
  interdependence, holistic analysis. Pillar = consciousness.

"interpretive-frameworks" = paradigms, worldviews, analytical lenses.
  Pillar = interpretation.

"language-recalibration" = redefining terminology, semantic precision,
  reclaiming words, discourse analysis. Pillar = interpretation.

"media-literacy" = evaluating media, misinformation, fake news, editorial bias.
  Pillar = interpretation.

"strategic-communication" = messaging, framing, PR, narrative management.
  Pillar = interpretation.

"narrative-framing" = agenda-setting, propaganda, spin, perception management.
  Pillar = interpretation.

"frequencies-and-influence" = structural signals, systemic prompts, resonance.
  Pillar = frequencies.

"social-development" = community development, social cohesion, capacity
  building, grassroots social programmes. Pillar = frequencies.

"institutional-reform" = systemic reform of institutions, reform architecture.
  Pillar = frequencies.

"performance-metrics" = KPIs, SCOI scoring, measurement frameworks, output
  evaluation, impact measurement. Pillar = frequencies.

"civilisation-theory" = society-building, cultural identity, heritage,
  civilisational progress, nation-state formation. Pillar = civilization.

"social-justice" = equality, discrimination, civil rights, inclusion, oppression.
  Pillar = civilization.

"human-rights" = universal rights, dignity, freedoms, refugee, torture.
  Pillar = civilization.

"electoral-systems" = elections, voting, democracy, ballots, political
  representation. Pillar = civilization.

"economic-justice" = inequality, poverty, redistribution, living wage.
  Pillar = civilization.

"environmental-governance" = climate policy, sustainability governance,
  conservation management, environmental regulation. Pillar = civilization.

"conflict-resolution" = mediation, peace, reconciliation, dialogue.
  Pillar = negotiation.

"negotiation-dynamics" = bargaining, leverage, concession, zone of agreement.
  Pillar = negotiation.

"diplomacy" = international relations, treaties, multilateral engagement.
  Pillar = negotiation.

"strategy" = strategic planning, competitive strategy, policy strategy,
  scenario planning. Pillar = negotiation.

"technology-governance" = AI policy, data governance, digital regulation,
  platform accountability. Pillar = technology.

"digital-ethics" = privacy, surveillance, algorithmic bias, AI ethics,
  data protection rights. Pillar = technology.

"ai-governance" = AI regulation, model governance, responsible AI frameworks,
  AI safety policy, algorithmic accountability. Pillar = technology.

"risk-and-compliance" = enterprise risk management, regulatory compliance,
  audit frameworks, internal controls, risk governance. Pillar = technology.

"innovation" = technology innovation, R&D policy, startup ecosystems,
  digital transformation, innovation governance. Pillar = technology.

"research-methodology" = data interpretation, qualitative/quantitative analysis,
  academic research frameworks. Pillar = interpretation.

══ SERIES NAMING RULES ══

A series is a LEARNING TRACK — a slug grouping 2+ quizzes on the same theme.
  • Use lowercase-hyphenated slugs: "governing-with-integrity"
  • Max 5 words
  • Quizzes on the same professional theme MUST share a series slug
  • The series slug must NOT repeat the category or pillar name as a suffix

Good examples:
  "governing-with-integrity", "public-finance-accountability",
  "rule-of-law-foundations", "ethics-in-public-service",
  "leadership-and-strategy", "ai-governance-frameworks",
  "human-rights-in-practice", "negotiation-and-diplomacy",
  "electoral-systems-in-practice", "media-and-framing",
  "change-management-essentials", "crisis-response-and-continuity"

Bad examples (too generic, DO NOT USE):
  "responsibility-series", "technology-1", "module-a", "quiz-set",
  "general-knowledge", "consciousness-topics"

══ OUT-OF-SCOPE ══

Pure academic content with NO governance/leadership/ethics/society link:
maths, algebra, pure biology, chemistry, physics, English grammar, geography
facts, basic history dates → set pillar="out-of-scope", category="out-of-scope"

══ OUTPUT FORMAT ══

Return ONLY a JSON array. No prose, no markdown, no backtick fences.
One object per quiz with EXACTLY these fields:

1. "id"           — the quiz _id exactly as given
2. "pillar"       — one of the 8 pillars OR "out-of-scope"
3. "category"     — most specific allowed category OR "out-of-scope"
4. "series"       — lowercase-hyphenated learning track (NOT the quiz title)
5. "seriesOrder"  — integer 1–10 by complexity within the series
6. "level"        — foundation | intermediate | advanced | expert
7. "title"        — clean professional display title (max 8 words, title case)
8. "confidence"   — float 0.0 to 1.0

Example:
[{"id":"64a1b2c3d4e5f6a7b8c9d0e1","pillar":"responsibility","category":"financial-accountability","series":"public-finance-accountability","seriesOrder":2,"level":"intermediate","title":"Budget Oversight in Public Institutions","confidence":0.96}]
`.trim();

// ── Anthropic API call with exponential retry ─────────────────────────────────
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
        model:      'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system:     QUIZ_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userContent }]
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
      const wait = Math.min(attempt * 20_000, 120_000);
      console.log(`  ⏳ Rate limited (${res.status}), attempt ${attempt}/${retries}, waiting ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  throw new Error('API overloaded after all retries');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeSlug(str) {
  return (str || 'general').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * Resolve AI-returned category to a valid slug.
 * Falls back to first allowed category for the pillar.
 */
function resolveCategory(aiCategory, pillar) {
  const slug = makeSlug(aiCategory || '');
  if (ALL_VALID_CATEGORIES.includes(slug)) return slug;
  return (PILLAR_CATEGORIES[pillar] || PILLAR_CATEGORIES.responsibility)[0];
}

/**
 * Light series slug normalisation:
 * Strip common suffixes/numerals so closely-related series merge.
 * e.g. "governance-series-1" → "governance-foundations"
 * The AI is also given strict naming rules, so this is a safety net.
 */
function normaliseSeriesSlug(slug, category) {
  if (!slug || slug === 'out-of-scope') return slug;
  // Remove trailing -1, -2 etc.
  const clean = slug.replace(/-\d+$/, '');
  // Remove trailing -series, -topics, -module
  return clean.replace(/-(series|topics?|modules?|set)$/, '');
}

// ── Step 0: Reset (skips manualOverride=true records) ────────────────────────
async function resetCategorisation() {
  console.log('\n━━━ STEP 0: Resetting AI categorisation (manual overrides protected) ━━━\n');
  const result = await Question.updateMany(
    {
      organization:            ORG_ID,
      'meta.manualOverride':   { $ne: true }
    },
    {
      $unset: {
        category: '', categories: '', series: '', seriesOrder: '',
        level: '', quizTitle: '',
        'meta.aiPillar':      '',
        'meta.aiConfidence':  '',
        'meta.aiCategorised': '',
        'meta.isOutOfScope':  '',
        'meta.inheritedFromQuiz': ''
      }
    }
  );
  console.log(`  Cleared ${result.modifiedCount} documents (manual overrides preserved).\n`);
}

// ── Step 1: Classify comprehension quizzes via Claude API ─────────────────────
async function categorizeQuizzes(stats) {
  console.log('━━━ STEP 1: Categorising comprehension quizzes (batch size 5) ━━━\n');
  let skip = 0, batch = 0;

  while (true) {
    const quizzes = await Question.find({
      organization:            ORG_ID,
      type:                    'comprehension',
      'meta.aiCategorised':    { $ne: true },
      'meta.manualOverride':   { $ne: true }
    })
      // v6: include quizTitle, tags, module for richer classification signal
      .select('_id text passage quizTitle module tags questionIds')
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

    // Build prompt content — richer v6: includes quizTitle, tags, module
    const userContent = quizzes.map(q => {
      const title      = (q.quizTitle || q.text || '').slice(0, 200);
      const passage    = (q.passage   || '').slice(0, 700);
      const tagsLine   = Array.isArray(q.tags) && q.tags.length
        ? `TAGS: ${q.tags.slice(0, 10).join(', ')}` : '';
      const moduleLine = q.module && q.module !== 'general'
        ? `EXISTING_MODULE: ${q.module}` : '';
      const childTexts = (q.questionIds || []).slice(0, 10)
        .map((id, i) => `Q${i + 1}: ${(childMap[String(id)] || '').slice(0, 150)}`)
        .filter(Boolean).join('\n');
      return [
        `ID: ${q._id}`,
        `TITLE: ${title}`,
        passage    ? `PASSAGE: ${passage}`       : '',
        tagsLine,
        moduleLine,
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
        const pillar       = VALID_PILLARS.includes(r.pillar) ? r.pillar : 'responsibility';
        const category     = isOutOfScope ? 'out-of-scope' : resolveCategory(r.category, pillar);
        const rawSeries    = isOutOfScope ? 'out-of-scope' : makeSlug(r.series || `${pillar}-studies`);
        const series       = isOutOfScope ? 'out-of-scope' : normaliseSeriesSlug(rawSeries, category);
        const seriesOrder  = typeof r.seriesOrder === 'number' ? Math.max(1, Math.min(10, r.seriesOrder)) : 1;
        const level        = VALID_LEVELS.includes(r.level) ? r.level : 'foundation';
        const title        = r.title || (q.quizTitle || q.text || '').slice(0, 80) || 'Untitled';
        const confidence   = r.confidence ?? null;

        if (isOutOfScope) stats.outOfScope++;
        stats.categorySeen[category] = (stats.categorySeen[category] || 0) + 1;
        stats.seriesSeen[series]     = (stats.seriesSeen[series]     || 0) + 1;
        if (!stats.pillarBreakdown[pillar]) stats.pillarBreakdown[pillar] = {};
        stats.pillarBreakdown[pillar][category] = (stats.pillarBreakdown[pillar][category] || 0) + 1;
        stats.quizzesModified++;

        // Track low-confidence items for manual review
        if ((confidence ?? 1) < CONFIDENCE_THRESHOLD) {
          stats.lowConfidence.push({
            id:         String(q._id),
            title,
            pillar,
            category,
            series,
            level,
            confidence: confidence ?? 0
          });
        }

        // Dry-run: accumulate stats only, no DB write
        if (stats.dryRun) return null;

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
                'meta.aiConfidence':  confidence,
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
      } else if (stats.dryRun) {
        const avgConf = (results.reduce((s, r) => s + (r?.confidence || 0), 0) / results.length).toFixed(2);
        console.log(`    [DRY-RUN] ${results.length} classified | avg confidence: ${avgConf}`);
      }

      // Log sample results
      results.slice(0, 3).forEach(r => {
        if (r) console.log(`      [${r.pillar}] ${r.category} → "${r.series}" — ${r.title}`);
      });

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

// ── Step 2: Propagate pillar/category/series to child questions ───────────────
async function propagateToChildren(stats) {
  console.log('━━━ STEP 2: Propagating to child questions ━━━\n');

  const quizzes = await Question.find({
    organization:           ORG_ID,
    type:                   'comprehension',
    'meta.aiCategorised':   true,
    'meta.isOutOfScope':    { $ne: true },
    questionIds:            { $exists: true, $not: { $size: 0 } }
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
          'meta.aiPillar':          quiz.meta?.aiPillar || 'responsibility',
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

// ── Step 3: Report-only — read DB and print breakdown ────────────────────────
async function reportOnly() {
  console.log('━━━ REPORT-ONLY MODE — Reading current DB state ━━━\n');

  const total = await Question.countDocuments({ organization: ORG_ID, type: 'comprehension' });
  const classified = await Question.countDocuments({
    organization: ORG_ID, type: 'comprehension', 'meta.aiCategorised': true
  });
  const outOfScope = await Question.countDocuments({
    organization: ORG_ID, type: 'comprehension', 'meta.isOutOfScope': true
  });
  const manualLocks = await Question.countDocuments({
    organization: ORG_ID, 'meta.manualOverride': true
  });
  const unclassified = total - classified;

  console.log(`  Total comprehension quizzes : ${total}`);
  console.log(`  Classified (aiCategorised)  : ${classified}`);
  console.log(`  Out-of-scope                : ${outOfScope}`);
  console.log(`  Unclassified                : ${unclassified}`);
  console.log(`  Manual override locks       : ${manualLocks}`);

  // Category breakdown from DB
  const catAgg = await Question.aggregate([
    { $match: { organization: ORG_ID, type: 'comprehension', 'meta.aiCategorised': true } },
    { $group: { _id: '$category', count: { $sum: 1 }, pillar: { $first: '$meta.aiPillar' } } },
    { $sort: { count: -1 } }
  ]);

  // Pillar breakdown from DB
  const pillarAgg = await Question.aggregate([
    { $match: { organization: ORG_ID, type: 'comprehension', 'meta.aiCategorised': true } },
    { $group: { _id: '$meta.aiPillar', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);

  // Low-confidence items from DB
  const lowConf = await Question.find({
    organization:         ORG_ID,
    type:                 'comprehension',
    'meta.aiCategorised': true,
    'meta.aiConfidence':  { $lt: CONFIDENCE_THRESHOLD }
  }).select('_id text quizTitle meta').lean();

  // Series count from DB
  const seriesAgg = await Question.aggregate([
    { $match: { organization: ORG_ID, type: 'comprehension', 'meta.aiCategorised': true, 'meta.isOutOfScope': { $ne: true }, series: { $nin: [null, '', 'out-of-scope'] } } },
    { $group: { _id: '$series', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);

  console.log('\n  ── PER-PILLAR BREAKDOWN ──────────────────────────────────────');
  for (const p of pillarAgg) {
    console.log(`  ${(p._id || 'unknown').toUpperCase().padEnd(20)} ${p.count} quizzes`);
  }

  console.log('\n  ── PER-CATEGORY BREAKDOWN (sorted by count) ─────────────────');
  for (const c of catAgg) {
    const owner = c.pillar || CATEGORY_TO_PILLAR[c._id] || '?';
    console.log(`  ${String(c.count).padStart(4)}×  ${(c._id || 'null').padEnd(35)} [${owner}]`);
  }

  const classifiedCats = new Set(catAgg.map(c => c._id).filter(Boolean));
  const emptyCats = ALL_VALID_CATEGORIES.filter(c => !classifiedCats.has(c));
  if (emptyCats.length) {
    console.log('\n  ── CATEGORIES WITH 0 QUIZZES (will NOT appear in dashboard) ─');
    emptyCats.forEach(c => console.log(`  ⚠  ${c}`));
  } else {
    console.log('\n  ✅ All defined categories have at least 1 quiz.');
  }

  console.log(`\n  ── SERIES DETECTED: ${seriesAgg.length} unique ──────────────────────────`);
  seriesAgg.slice(0, 20).forEach(s => console.log(`  ${String(s.count).padStart(4)}×  ${s._id}`));
  if (seriesAgg.length > 20) console.log(`  … and ${seriesAgg.length - 20} more.`);

  console.log(`\n  ── LOW-CONFIDENCE ITEMS (< ${CONFIDENCE_THRESHOLD}) ─────────────────────────`);
  if (!lowConf.length) {
    console.log('  (none — all items above threshold)');
  } else {
    lowConf.slice(0, 20).forEach(d =>
      console.log(`  [${(d.meta?.aiConfidence ?? 0).toFixed(2)}] ${d.meta?.aiPillar}/${d.category} → "${d.quizTitle || d.text?.slice(0, 60)}" (${d._id})`)
    );
    if (lowConf.length > 20) console.log(`  … and ${lowConf.length - 20} more.`);
  }

  console.log('\n  ── OUT-OF-SCOPE QUIZ TITLES ──────────────────────────────────');
  const oos = await Question.find({
    organization: ORG_ID, type: 'comprehension', 'meta.isOutOfScope': true
  }).select('_id text quizTitle').lean();
  if (oos.length === 0) console.log('  (none)');
  else oos.forEach(d => console.log(`  ${d._id}  "${(d.quizTitle || d.text || '').slice(0, 70)}"`));
}

// ── Final report (after live run or dry-run) ──────────────────────────────────
function printRunReport(stats) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(stats.dryRun
    ? '  DRY-RUN CLASSIFICATION REPORT — NO DATA WAS WRITTEN'
    : '  RE-CATEGORISATION COMPLETE — VERIFY BEFORE GOING LIVE'
  );
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Quizzes processed   : ${stats.quizzesModified}`);
  console.log(`  Out-of-scope flagged: ${stats.outOfScope}`);
  console.log(`  Children propagated : ${stats.dryRun ? '(skipped)' : stats.propagated}`);
  console.log(`  Batch errors        : ${stats.errors}`);
  console.log(`  Unique categories   : ${Object.keys(stats.categorySeen).length}`);
  console.log(`  Unique series       : ${Object.keys(stats.seriesSeen).length}`);
  console.log(`  Low-confidence (<${CONFIDENCE_THRESHOLD}): ${stats.lowConfidence.length}`);

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

  console.log('\n  ── ALL SERIES BY COUNT ───────────────────────────────────────');
  Object.entries(stats.seriesSeen).sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}×  ${k}`));

  if (stats.lowConfidence.length) {
    console.log(`\n  ── LOW-CONFIDENCE ITEMS (< ${CONFIDENCE_THRESHOLD}) — MANUAL REVIEW NEEDED ──`);
    stats.lowConfidence.slice(0, 30).forEach(item =>
      console.log(`    [${(item.confidence || 0).toFixed(2)}] ${item.pillar}/${item.category} → "${item.title}" (${item.id})`)
    );
    if (stats.lowConfidence.length > 30)
      console.log(`    … and ${stats.lowConfidence.length - 30} more.`);

    // Write review JSON for admin UI
    if (!stats.dryRun) {
      try {
        if (!fs.existsSync(REVIEW_OUTPUT_DIR)) fs.mkdirSync(REVIEW_OUTPUT_DIR, { recursive: true });
        const outPath = path.join(REVIEW_OUTPUT_DIR, 'low-confidence-items.json');
        fs.writeFileSync(outPath, JSON.stringify(stats.lowConfidence, null, 2));
        console.log(`\n  📄 Review file written: ${outPath}`);
      } catch (e) {
        console.warn('  ⚠  Could not write review file:', e.message);
      }
    }
  }

  const unseenCategories = ALL_VALID_CATEGORIES.filter(c => !stats.categorySeen[c]);
  console.log('\n  ── CATEGORIES WITH ZERO QUIZZES (missing from DB) ───────────');
  if (unseenCategories.length === 0) {
    console.log('    (all categories have at least 1 quiz — good coverage)');
  } else {
    unseenCategories.forEach(c => console.log(`    ⚠  ${c}  (0 quizzes — will not appear in dashboard)`));
  }

  if (stats.dryRun) {
    console.log('\n⚠️  DRY-RUN COMPLETE — No data was written to the database.');
    console.log('   Review the distribution above, then run without --dry-run to apply.\n');
  } else {
    console.log('\n✅ Done. Review the distribution above before going live.\n');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const DRY_RUN     = process.argv.includes('--dry-run');
  const REPORT_ONLY = process.argv.includes('--report-only');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB.\n');

  if (REPORT_ONLY) {
    await reportOnly();
    await mongoose.disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log('⚠️  DRY-RUN MODE — scanning and classifying but NO writes will occur.\n');
  }

  const stats = {
    quizzesModified: 0,
    propagated:      0,
    errors:          0,
    outOfScope:      0,
    categorySeen:    {},
    seriesSeen:      {},
    pillarBreakdown: {},
    lowConfidence:   [],
    dryRun:          DRY_RUN
  };

  const total = await Question.countDocuments({ organization: ORG_ID, type: 'comprehension' });
  const manualLocks = await Question.countDocuments({
    organization: ORG_ID, 'meta.manualOverride': true
  });
  console.log(`📊 Total comprehension quizzes : ${total}`);
  console.log(`🔒 Manual override locks       : ${manualLocks} (will be skipped)\n`);

  if (!DRY_RUN) await resetCategorisation();
  await categorizeQuizzes(stats);
  if (!DRY_RUN) await propagateToChildren(stats);
  else console.log('  ↳ DRY-RUN: propagateToChildren skipped.\n');

  printRunReport(stats);

  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });