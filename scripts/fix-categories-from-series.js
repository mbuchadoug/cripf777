// scripts/fix-categories-from-series.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME FIX: rebuilds category + series fields on Question documents
// where category is null but series is set (from a previous categorisation run
// that got partially wiped).
//
// Run: node scripts/fix-categories-from-series.js --dry-run
// Run: node scripts/fix-categories-from-series.js
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import Question from '../models/question.js';
import dotenv   from 'dotenv';
dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const ORG_ID_STR = process.env.CRIPFCNT_ORG_ID || '693b3d8d8004ece0477340c7';

// ── Series slug → category (built from your categorisation report output) ───
const SERIES_TO_CATEGORY = {
  // structural-responsibility (120×)
  'pyramids-of-lies':                        'structural-responsibility',
  'pyramids-of-lies-analysis':               'structural-responsibility',
  'frameworks-power-responsibility':         'structural-responsibility',
  'responsibility-and-placement':            'structural-responsibility',
  'placement-and-accountability':            'structural-responsibility',
  'responsibility-beyond-exit':              'structural-responsibility',
  'responsibility-and-placement-foundations':'structural-responsibility',
  'late-stage-system-dynamics':              'structural-responsibility',
  'visibility-versus-contribution':          'structural-responsibility',
  'placement-and-exit-governance':           'structural-responsibility',
  'placement-and-system-design':             'structural-responsibility',
  'capability-and-placement-alignment':      'structural-responsibility',

  // interpretive-frameworks (97×)
  'systemic-exit-and-market-integrity':      'interpretive-frameworks',
  'love-and-exchange-dynamics':              'interpretive-frameworks',
  'conditioning-and-choice':                 'interpretive-frameworks',
  'cripfcnt-operating-system':               'interpretive-frameworks',
  'cripfcnt-structural-intelligence':        'interpretive-frameworks',
  'internal-alignment-development':          'interpretive-frameworks',
  'cripfcnt-foundational-concepts':          'interpretive-frameworks',

  // systems-thinking (48×)
  'cripfcnt-framework-foundations':          'systems-thinking',
  'consciousness-and-placement-foundations': 'systems-thinking',
  'cripfcnt-framework-origins':              'systems-thinking',

  // civilisation-theory (39×)
  'civilization-diagnostics-framework':      'civilisation-theory',

  // consciousness-studies (27×)
  'scoi-framework-origins':                  'consciousness-studies',
  'scoi-origins-and-signals':                'consciousness-studies',

  // performance-metrics (22×)
  'scoi-measurement-framework':              'performance-metrics',

  // institutional-accountability (20×)
  'teaching-with-responsibility':            'institutional-accountability',

  // financial-accountability (15×)
  'ai-energy-fiduciary-responsibility':      'financial-accountability',

  // language-recalibration (14×)
  'ai-energy-governance':                    'language-recalibration',

  // strategic-leadership (10×)
  'ai-governance-and-accountability':        'strategic-leadership',

  // frequencies-and-influence (10×)
  'scoi-framework-origins':                  'frequencies-and-influence',
};

// ── Category → pillar ────────────────────────────────────────────────────────
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
  'digital-ethics':               'technology',
  'technology-governance':        'technology',
  'ai-governance':                'technology',
  'negotiation-dynamics':         'negotiation',
};

function slugToLabel(s) {
  return (s || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  if (DRY_RUN) console.log('⚠️  DRY-RUN - no writes\n');

  // ── Step 1: diagnose current state ────────────────────────────────────────
  const total       = await Question.countDocuments({ type: 'comprehension' });
  const withCat     = await Question.countDocuments({ type: 'comprehension', category: { $nin: [null, ''] } });
  const withSeries  = await Question.countDocuments({ type: 'comprehension', series:   { $nin: [null, ''] } });
  const nullCat     = await Question.countDocuments({ type: 'comprehension', category: null });

  console.log(`Total comprehension docs : ${total}`);
  console.log(`Have category set        : ${withCat}`);
  console.log(`Have series set          : ${withSeries}`);
  console.log(`category is null         : ${nullCat}\n`);

  if (withCat > 0) {
    // Categories already set - show breakdown
    const catBreakdown = await Question.aggregate([
      { $match: { type: 'comprehension', category: { $nin: [null, '', 'out-of-scope'] } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort:  { count: -1 } }
    ]);
    console.log('Categories already in DB:');
    catBreakdown.forEach(c => console.log(`  ${String(c.count).padStart(4)}×  ${c._id}`));
    console.log('\n✅ Categories look good - no fix needed. Check your route aggregate instead.\n');
    console.log('The issue is likely that Question.organization is stored as a STRING');
    console.log(`("${ORG_ID_STR}") but your aggregate filters by ObjectId.`);
    console.log('Use the triple-fallback route provided, or run this in Mongo shell:');
    console.log(`db.questions.aggregate([{$match:{type:"comprehension",category:{$nin:[null,"","out-of-scope"]}}},{$group:{_id:"$category",count:{$sum:1}}},{$sort:{count:-1}}])`);
    await mongoose.disconnect();
    return;
  }

  // ── Step 2: nullCat > 0 - rebuild from series ────────────────────────────
  console.log('category is null on all docs. Rebuilding from series slugs...\n');

  const docs = await Question.find({
    type:   'comprehension',
    series: { $nin: [null, '', 'out-of-scope'] }
  }).select('_id series').lean();

  console.log(`  ${docs.length} docs have a series slug to rebuild from`);

  let matched = 0, unmatched = 0;
  const ops = [];

  for (const doc of docs) {
    const cat    = SERIES_TO_CATEGORY[doc.series];
    const pillar = cat ? (CATEGORY_TO_PILLAR[cat] || 'responsibility') : null;

    if (!cat) {
      unmatched++;
      continue;
    }

    matched++;
    if (!DRY_RUN) {
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: {
              category:          cat,
              categories:        [cat],
              'meta.aiPillar':   pillar,
              'meta.aiCategorised': true,
              updatedAt:         new Date()
            }
          }
        }
      });
    }
  }

  console.log(`  Matched   : ${matched}`);
  console.log(`  Unmatched : ${unmatched} (series slug not in SERIES_TO_CATEGORY map)`);

  if (!DRY_RUN && ops.length) {
    const result = await Question.bulkWrite(ops);
    console.log(`\n✅ Updated ${result.modifiedCount} documents.`);
  } else if (DRY_RUN) {
    console.log('\n⚠️  DRY-RUN complete - run without --dry-run to apply.');
  }

  // ── Step 3: show unmatched series ─────────────────────────────────────────
  if (unmatched > 0) {
    const unmatchedSeries = await Question.aggregate([
      { $match: { type: 'comprehension', category: null, series: { $nin: [null, ''] } } },
      { $group: { _id: '$series', count: { $sum: 1 } } },
      { $sort:  { count: -1 } }
    ]);
    console.log('\nSeries slugs with no category mapping (add to SERIES_TO_CATEGORY):');
    unmatchedSeries.forEach(s => console.log(`  ${String(s.count).padStart(4)}×  '${s._id}': 'CATEGORY_HERE',`));
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch(e => { console.error(e); process.exit(1); });