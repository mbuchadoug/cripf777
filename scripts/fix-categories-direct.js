// scripts/fix-categories-direct.js
// Run: node scripts/fix-categories-direct.js --dry-run
// Run: node scripts/fix-categories-direct.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

// ── Complete series → category map (all 174 series from your DB) ─────────────
const SERIES_TO_CATEGORY = {
  // structural-responsibility
  'pyramids-of-lies':                              'structural-responsibility',
  'pyramids-of-lies-analysis':                     'structural-responsibility',
  'pyramids-of-lies-microbook':                    'structural-responsibility',
  'frameworks-power-responsibility':               'structural-responsibility',
  'responsibility-and-placement':                  'structural-responsibility',
  'placement-and-accountability':                  'structural-responsibility',
  'responsibility-beyond-exit':                    'structural-responsibility',
  'responsibility-and-placement-foundations':      'structural-responsibility',
  'late-stage-system-dynamics':                    'structural-responsibility',
  'visibility-versus-contribution':                'structural-responsibility',
  'placement-and-exit-governance':                 'structural-responsibility',
  'placement-and-system-design':                   'structural-responsibility',
  'capability-and-placement-alignment':            'structural-responsibility',
  'responsibility-and-accountability-systems':     'structural-responsibility',
  'responsibility-fundamentals':                   'structural-responsibility',
  'responsibility-and-systems':                    'structural-responsibility',
  'systemic-responsibility-patterns':              'structural-responsibility',
  'responsibility-framework-analysis':             'structural-responsibility',
  'responsibility-under-uncertainty':              'structural-responsibility',
  'responsibility-and-meaning-frameworks':         'structural-responsibility',
  'scale-and-systemic-obligation':                 'structural-responsibility',
  'responsibility-foundations':                    'structural-responsibility',
  'responsibility-through-storytelling':           'structural-responsibility',
  'responsibility-and-knowledge':                  'structural-responsibility',
  'escalating-responsibility-standards':           'structural-responsibility',
  'faith-and-responsibility':                      'structural-responsibility',
  'keeping-promises-and-commitments':              'structural-responsibility',
  'early-responsibility-learning':                 'structural-responsibility',
  'classroom-management-responsibility':           'structural-responsibility',
  'direction-before-discipline':                   'structural-responsibility',
  'motivation-discipline-responsibility':          'structural-responsibility',
  'hierarchy-and-placement':                       'structural-responsibility',
  'placement-and-organizational-awareness':        'structural-responsibility',
  'placement-and-action':                          'structural-responsibility',
  'systems-and-structural-placement':              'structural-responsibility',
  'early-warning-and-responsibility':              'structural-responsibility',
  'talent-and-placement':                          'structural-responsibility',
  'learning-incentives-responsibility':            'structural-responsibility',

  // institutional-accountability
  'teaching-with-responsibility':                  'institutional-accountability',
  'centralization-and-accountability':             'institutional-accountability',
  'accountability-and-outcomes':                   'institutional-accountability',
  'governance-accountability-fundamentals':        'institutional-accountability',
  'authority-measurement-frameworks':              'institutional-accountability',
  'credibility-and-authority':                     'institutional-accountability',
  'transparency-and-trust':                        'institutional-accountability',
  'liberation-memory-and-accountability':          'institutional-accountability',
  'democracy-and-performance':                     'institutional-accountability',
  'structural-audit-framework':                    'institutional-accountability',
  'conduct-over-performance':                      'institutional-accountability',
  'cripfcnt-conduct-standards':                    'institutional-accountability',

  // interpretive-frameworks
  'systemic-exit-and-market-integrity':            'interpretive-frameworks',
  'love-and-exchange-dynamics':                    'interpretive-frameworks',
  'conditioning-and-choice':                       'interpretive-frameworks',
  'cripfcnt-operating-system':                     'interpretive-frameworks',
  'cripfcnt-structural-intelligence':              'interpretive-frameworks',
  'internal-alignment-development':                'interpretive-frameworks',
  'cripfcnt-foundational-concepts':                'interpretive-frameworks',
  'cripfcnt-life-operating-system':                'interpretive-frameworks',
  'understanding-operating-systems':               'interpretive-frameworks',
  'pillars-vs-rules-framework':                    'interpretive-frameworks',
  'framework-transition':                          'interpretive-frameworks',
  'cripfcnt-foundations':                          'interpretive-frameworks',
  'cripfcnt-foundational-principles':              'interpretive-frameworks',
  'cripfcnt-learning-foundations':                 'interpretive-frameworks',
  'cripfcnt-learning-posture':                     'interpretive-frameworks',
  'cripfcnt-learning-methodology':                 'interpretive-frameworks',
  'permanent-learning-posture':                    'interpretive-frameworks',
  'learning-without-submission':                   'interpretive-frameworks',
  'learning-and-expression-dynamics':              'interpretive-frameworks',
  'foundational-learning-principles':              'interpretive-frameworks',
  'deep-learning-integration':                     'interpretive-frameworks',
  'attention-and-learning':                        'interpretive-frameworks',
  'learning-from-existing-frameworks':             'interpretive-frameworks',

  // language-recalibration / interpretation
  'ai-energy-governance':                          'language-recalibration',
  'cripfcnt-interpretation-fundamentals':          'interpretive-frameworks',
  'interpretation-fundamentals':                   'interpretive-frameworks',
  'interpretation-and-meaning':                    'interpretive-frameworks',
  'meaning-and-interpretation':                    'interpretive-frameworks',
  'meaning-examination-and-inquiry':               'interpretive-frameworks',
  'framing-truth-and-meaning':                     'interpretive-frameworks',
  'same-words-different-axis':                     'language-recalibration',
  'cripfcnt-love-exchange-dynamics':               'interpretive-frameworks',
  'conditioning-and-interpretation':               'interpretive-frameworks',
  'interpretation-to-ownership':                   'interpretive-frameworks',

  // systems-thinking
  'cripfcnt-framework-foundations':                'systems-thinking',
  'consciousness-and-placement-foundations':       'systems-thinking',
  'cripfcnt-framework-origins':                    'systems-thinking',
  'factorial-space-and-coherence':                 'systems-thinking',
  'factorials-of-intelligence':                    'systems-thinking',
  'factorial-intelligence-theory':                 'systems-thinking',
  'system-literacy-and-power':                     'systems-thinking',
  'systems-over-politics':                         'systems-thinking',
  'structure-and-systems':                         'systems-thinking',
  'information-processing-capacity':               'systems-thinking',
  'diagnostic-thinking-approach':                  'systems-thinking',
  'diagnostic-error-patterns':                     'systems-thinking',
  'post-control-system-dynamics':                  'systems-thinking',
  'system-capture-and-archetypes':                 'systems-thinking',
  'system-capture-and-control':                    'systems-thinking',
  'surface-intelligence-systems':                  'systems-thinking',
  'structural-depth-analysis':                     'systems-thinking',
  'rare-combinations-institutional-survival':      'systems-thinking',
  'institutional-intelligence-theory':             'systems-thinking',
  'alignment-versus-consensus':                    'systems-thinking',
  'observation-before-action':                     'systems-thinking',
  'clinic-before-automation':                      'systems-thinking',
  'incentive-architecture-foundations':            'systems-thinking',

  // consciousness-studies
  'scoi-framework-origins':                        'consciousness-studies',
  'scoi-origins-and-signals':                      'consciousness-studies',
  'harnessing-consciousness-framework':            'consciousness-studies',
  'harnessing-consciousness-dynamics':             'consciousness-studies',
  'harnessing-consciousness':                      'consciousness-studies',
  'consciousness-and-placement':                   'consciousness-studies',
  'consciousness-and-authority':                   'consciousness-studies',
  'mentalmonia-cognitive-patterns':                'consciousness-studies',

  // philosophical-inquiry
  'philosophy-and-civilisation':                   'philosophical-inquiry',
  'ethics-and-civilization-foundations':           'philosophical-inquiry',
  'clarity-and-truth-frameworks':                  'philosophical-inquiry',
  'combinatorial-thought-in-history':              'philosophical-inquiry',
  'lineage-and-intellectual-depth':                'philosophical-inquiry',
  'reality-curve-control-theory':                  'philosophical-inquiry',
  'mastery-and-control-frameworks':                'philosophical-inquiry',
  'direction-and-discipline':                      'philosophical-inquiry',
  'purpose-and-direction':                         'purpose-implementation',

  // performance-metrics
  'scoi-measurement-framework':                    'performance-metrics',
  'scoi-measurement-frameworks':                   'performance-metrics',
  'scoi-and-responsibility-escalation':            'performance-metrics',
  'systemic-exit-and-scoi':                        'performance-metrics',
  'performance-versus-contribution':               'performance-metrics',
  'performance-and-resilience':                    'performance-metrics',
  'metrics-versus-meaning':                        'performance-metrics',
  'authority-and-governance':                      'performance-metrics',
  'reform-measurement-dynamics':                   'performance-metrics',
  'optimization-versus-progress':                  'performance-metrics',
  'order-versus-health':                           'performance-metrics',
  'scale-versus-strength':                         'performance-metrics',

  // civilisation-theory
  'civilization-diagnostics-framework':            'civilisation-theory',
  'civilization-diagnostics':                      'civilisation-theory',
  'civilization-transition-dynamics':              'civilisation-theory',
  'civilizational-phase-transitions':              'civilisation-theory',
  'civilizational-stagnation-and-progress':        'civilisation-theory',
  'civilization-and-recursive-failure':            'civilisation-theory',
  'civilization-and-progress':                     'civilisation-theory',
  'civilization-vs-survival-thinking':             'civilisation-theory',
  'civilization-thinking-layers':                  'civilisation-theory',
  'civilization-protocol-implementation':          'civilisation-theory',
  'signaling-and-civilization-cycles':             'civilisation-theory',

  // financial-accountability
  'ai-energy-fiduciary-responsibility':            'financial-accountability',
  'monetary-systems-analysis':                     'financial-accountability',
  'accumulation-and-redistribution-theory':        'financial-accountability',

  // strategic-leadership
  'ai-governance-and-accountability':              'strategic-leadership',
  'ceo-energy-strategy':                           'strategic-leadership',
  'leadership-and-communication':                  'strategic-leadership',
  'excellence-failure-paradox':                    'strategic-leadership',
  'credibility-and-authority':                     'strategic-leadership',
  'public-interpretation-archive':                 'strategic-leadership',

  // organisational-development
  'cripfcnt-quotient-assessments':                 'organisational-development',
  'cripfcnt-quotient-assessment':                  'organisational-development',
  'cripfcnt-placement-assessment':                 'organisational-development',
  'cripfcnt-certification-foundations':            'organisational-development',
  'cripfcnt-case-studies':                         'organisational-development',
  'organizational-values-and-structure':           'organisational-development',
  'cripfcnt-peterson-frameworks':                  'organisational-development',

  // education
  'cripfcnt-learning-methodology':                 'education',

  // digital-ethics / technology
  'ai-environmental-impact':                       'digital-ethics',
  'ai-environmental-governance':                   'environmental-governance',
  'ai-material-reality':                           'digital-ethics',
  'ai-energy-policy-systems':                      'technology-governance',
  'human-signal-preservation':                     'digital-ethics',

  // social-justice / civilization
  'equality-and-fairness-fundamentals':            'social-justice',
  'liberation-memory-and-accountability':          'social-justice',

  // negotiation/strategy
  'cripfcnt-foundations':                          'interpretive-frameworks',

  // uk governance
  'uk-constitutional-foundations':                 'governance',

  // motivation
  'motivation-and-placement-theory':               'motivation',

  // frequencies
  'frequencies-and-influence':                     'frequencies-and-influence',
};

// ── FINAL OVERRIDE: remove wrong dup - credibility-and-authority picks strategic-leadership ──
SERIES_TO_CATEGORY['credibility-and-authority'] = 'institutional-accountability';

const CATEGORY_TO_PILLAR = {
  'structural-responsibility':    'responsibility',
  'institutional-accountability': 'responsibility',
  'financial-accountability':     'responsibility',
  'public-sector-ethics':         'responsibility',
  'social-contract':              'responsibility',
  'administration':               'responsibility',
  'governance':                   'responsibility',
  'performance-metrics':          'frequencies',
  'frequencies-and-influence':    'frequencies',
  'interpretive-frameworks':      'interpretation',
  'language-recalibration':       'interpretation',
  'narrative-framing':            'interpretation',
  'systems-thinking':             'consciousness',
  'consciousness-studies':        'consciousness',
  'philosophical-inquiry':        'consciousness',
  'education':                    'consciousness',
  'critical-thinking':            'consciousness',
  'civilisation-theory':          'civilization',
  'social-justice':               'civilization',
  'environmental-governance':     'civilization',
  'public-policy':                'civilization',
  'strategic-leadership':         'purpose',
  'organisational-development':   'purpose',
  'motivation':                   'purpose',
  'human-resources':              'purpose',
  'change-management':            'purpose',
  'purpose-implementation':       'purpose',
  'digital-ethics':               'technology',
  'technology-governance':        'technology',
  'ai-governance':                'technology',
  'negotiation-dynamics':         'negotiation',
};

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected\n');
  if (DRY_RUN) console.log('⚠️  DRY-RUN\n');

  const col = mongoose.connection.db.collection('questions');

  const docs = await col.find({
    type:   'comprehension',
    series: { $exists: true, $nin: [null, '', 'out-of-scope'] }
  }).project({ _id: 1, series: 1 }).toArray();

  console.log(`Comprehension docs with series: ${docs.length}`);

  const ops = [];
  let matched = 0, unmatched = 0;
  const unmatchedSet = new Map();

  for (const doc of docs) {
    const cat    = SERIES_TO_CATEGORY[doc.series];
    const pillar = cat ? (CATEGORY_TO_PILLAR[cat] || 'responsibility') : null;

    if (!cat) {
      unmatched++;
      unmatchedSet.set(doc.series, (unmatchedSet.get(doc.series) || 0) + 1);
      continue;
    }
    matched++;
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            category:             cat,
            categories:           [cat],
            'meta.aiPillar':      pillar,
            'meta.aiCategorised': true,
            updatedAt:            new Date()
          }
        }
      }
    });
  }

  console.log(`Will update : ${matched} docs`);
  console.log(`Unmatched   : ${unmatched} docs (no series→category mapping)`);

  if (unmatchedSet.size) {
    console.log('\nStill unmatched series:');
    [...unmatchedSet.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 20)
      .forEach(([s,n]) => console.log(`  ${String(n).padStart(3)}×  ${s}`));
  }

  if (DRY_RUN) {
    console.log('\n⚠️  DRY-RUN - run without --dry-run to apply.\n');

    // Show what categories would be created
    const catCount = {};
    for (const op of ops) {
      const cat = op.updateOne.update.$set.category;
      catCount[cat] = (catCount[cat] || 0) + 1;
    }
    console.log('Categories that would be written:');
    Object.entries(catCount).sort((a,b)=>b[1]-a[1])
      .forEach(([c,n]) => console.log(`  ${String(n).padStart(4)}×  ${c}`));
    await mongoose.disconnect();
    return;
  }

  if (ops.length) {
    const result = await col.bulkWrite(ops);
    console.log(`\n✅ Updated ${result.modifiedCount} documents.\n`);

    // Verify
    const after = await col.aggregate([
      { $match: { type: 'comprehension', category: { $exists: true, $nin: [null, '', 'out-of-scope'] } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    console.log('✅ Categories now in DB:');
    after.forEach(c => console.log(`  ${String(c.count).padStart(4)}×  ${c._id}`));
    console.log(`\nTotal categories: ${after.length}`);
  }

  await mongoose.disconnect();
  console.log('\nDone. Restart your server - category cards will appear.');
}

run().catch(e => { console.error(e); process.exit(1); });