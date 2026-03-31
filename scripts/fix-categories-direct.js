// scripts/fix-categories-direct.js
// Run: node scripts/fix-categories-direct.js --dry-run
// Run: node scripts/fix-categories-direct.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

// ── Series → category mapping (from your categorisation report) ──────────────
const SERIES_TO_CATEGORY = {
  'pyramids-of-lies':                         'structural-responsibility',
  'pyramids-of-lies-analysis':                'structural-responsibility',
  'frameworks-power-responsibility':          'structural-responsibility',
  'responsibility-and-placement':             'structural-responsibility',
  'placement-and-accountability':             'structural-responsibility',
  'responsibility-beyond-exit':               'structural-responsibility',
  'responsibility-and-placement-foundations': 'structural-responsibility',
  'late-stage-system-dynamics':               'structural-responsibility',
  'visibility-versus-contribution':           'structural-responsibility',
  'placement-and-exit-governance':            'structural-responsibility',
  'placement-and-system-design':              'structural-responsibility',
  'capability-and-placement-alignment':       'structural-responsibility',
  'teaching-with-responsibility':             'institutional-accountability',
  'systemic-exit-and-market-integrity':       'interpretive-frameworks',
  'love-and-exchange-dynamics':               'interpretive-frameworks',
  'conditioning-and-choice':                  'interpretive-frameworks',
  'cripfcnt-operating-system':                'interpretive-frameworks',
  'cripfcnt-structural-intelligence':         'interpretive-frameworks',
  'internal-alignment-development':           'interpretive-frameworks',
  'cripfcnt-foundational-concepts':           'interpretive-frameworks',
  'cripfcnt-framework-foundations':           'systems-thinking',
  'consciousness-and-placement-foundations':  'systems-thinking',
  'scoi-measurement-framework':               'performance-metrics',
  'civilization-diagnostics-framework':       'civilisation-theory',
  'scoi-framework-origins':                   'consciousness-studies',
  'scoi-origins-and-signals':                 'consciousness-studies',
  'ai-energy-fiduciary-responsibility':       'financial-accountability',
  'ai-energy-governance':                     'language-recalibration',
  'ai-governance-and-accountability':         'strategic-leadership',
  'cripfcnt-framework-origins':               'systems-thinking',
};

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

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected\n');
  if (DRY_RUN) console.log('⚠️  DRY-RUN\n');

  const db = mongoose.connection.db;
  const col = db.collection('questions');

  // ── Raw diagnostic — bypass Mongoose entirely ─────────────────────────────
  const total = await col.countDocuments({ type: 'comprehension' });
  const sample = await col.findOne({ type: 'comprehension' });
  console.log('Total comprehension docs:', total);
  console.log('Sample doc fields:', Object.keys(sample || {}));
  console.log('Sample category value:', JSON.stringify(sample?.category));
  console.log('Sample organization value:', JSON.stringify(sample?.organization));
  console.log('Sample series value:', JSON.stringify(sample?.series));
  console.log();

  // ── Category breakdown (raw, bypass Mongoose) ────────────────────────────
  const catBreakdown = await col.aggregate([
    { $match: { type: 'comprehension' } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 15 }
  ]).toArray();
  console.log('Top category values in DB (raw):');
  catBreakdown.forEach(c => console.log(`  ${String(c.count).padStart(4)}×  ${JSON.stringify(c._id)}`));
  console.log();

  // ── Check how many have a real non-null category ──────────────────────────
  const withRealCat = await col.countDocuments({
    type: 'comprehension',
    category: { $exists: true, $ne: null, $nin: ['', 'out-of-scope'] }
  });
  console.log(`Docs with real category (not null/empty/out-of-scope): ${withRealCat}`);

  if (withRealCat > 0) {
    console.log('\n✅ Category data IS in the DB. The problem is in the route aggregate.');
    console.log('The organization field type mismatch is causing 0 results.');
    console.log('\nFix: the triple-fallback route (attempt3, no org filter) will work.');
    console.log('Make sure attempt3 is NOT filtering by organization at all.\n');
    await mongoose.disconnect();
    return;
  }

  // ── Category is genuinely null everywhere — fix from series ──────────────
  console.log('Category is null everywhere. Rebuilding from series slugs...\n');

  const docs = await col.find({
    type:   'comprehension',
    series: { $exists: true, $nin: [null, '', 'out-of-scope'] }
  }).project({ _id: 1, series: 1 }).toArray();

  console.log(`Docs with series set: ${docs.length}`);

  const ops = [];
  let matched = 0, unmatched = 0;
  const unmatchedSeries = new Map();

  for (const doc of docs) {
    const cat    = SERIES_TO_CATEGORY[doc.series];
    const pillar = cat ? (CATEGORY_TO_PILLAR[cat] || 'responsibility') : null;

    if (!cat) {
      unmatched++;
      unmatchedSeries.set(doc.series, (unmatchedSeries.get(doc.series) || 0) + 1);
      continue;
    }
    matched++;
    if (!DRY_RUN) {
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { category: cat, categories: [cat], 'meta.aiPillar': pillar, 'meta.aiCategorised': true, updatedAt: new Date() } }
        }
      });
    }
  }

  console.log(`Matched   : ${matched}`);
  console.log(`Unmatched : ${unmatched}`);

  if (unmatchedSeries.size) {
    console.log('\nUnmatched series (add to SERIES_TO_CATEGORY map):');
    [...unmatchedSeries.entries()].sort((a,b)=>b[1]-a[1]).forEach(([s,n])=>
      console.log(`  ${String(n).padStart(4)}×  '${s}': 'CATEGORY_HERE',`));
  }

  if (!DRY_RUN && ops.length) {
    const result = await col.bulkWrite(ops);
    console.log(`\n✅ Updated ${result.modifiedCount} documents.`);

    // Verify
    const after = await col.aggregate([
      { $match: { type: 'comprehension', category: { $exists: true, $ne: null, $nin: ['', 'out-of-scope'] } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    console.log('\nCategories now in DB:');
    after.forEach(c => console.log(`  ${String(c.count).padStart(4)}×  ${c._id}`));
  } else if (DRY_RUN) {
    console.log('\nDRY-RUN complete — run without --dry-run to apply.');
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch(e => { console.error(e); process.exit(1); });