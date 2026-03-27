// scripts/ai-categorize-questions.js
import mongoose from 'mongoose';
import Question from '../models/question.js';
import dotenv from 'dotenv';
dotenv.config();
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY is not set. Check your .env file.');
  process.exit(1);
}
console.log('✅ API key loaded:', process.env.ANTHROPIC_API_KEY.slice(0, 15) + '...');

const BATCH_SIZE = 20; // 20 questions per API call (cost-efficient)

const SYSTEM_PROMPT = `You are a CRIPFCNT framework categorization engine.

CRIPFCNT stands for: Consciousness, Responsibility, Interpretation, Purpose, Frequencies, Civilization, Negotiation, Technology.

Given a list of quiz questions (each with their text and current module), return a JSON array where each item assigns:

1. "category" — the professional domain. Pick EXACTLY ONE from:
   leadership | governance | public-policy | legal-compliance | hr-people-management |
   finance-economics | education | healthcare | technology-it | communications-media |
   entrepreneurship | social-development | environment-climate | general

2. "series" — the learning pathway. Pick EXACTLY ONE from:
   leadership-governance-series | accountability-ethics-series | strategic-intelligence-series |
   communication-influence-series | digital-transformation-series | civic-civilisation-series |
   entrepreneurial-purpose-series | negotiation-diplomacy-series |
   consciousness-wellbeing-series | foundation-series

3. "pillar" — the CRIPFCNT pillar (module). Pick EXACTLY ONE from:
   consciousness | responsibility | interpretation | purpose |
   frequencies | civilization | negotiation | technology | general

4. "confidence" — your confidence 0.0–1.0

Return ONLY a valid JSON array. No prose, no markdown, no backticks. Example:
[{"id":"abc123","category":"governance","series":"accountability-ethics-series","pillar":"responsibility","confidence":0.91}]`;

async function categorizeBatch(questions) {
  const userContent = questions.map(q =>
    `ID: ${q._id}\nModule: ${q.module || 'general'}\nText: ${q.text}`
  ).join('\n\n---\n\n');

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
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');

  // Strip any accidental markdown fences
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected. Starting AI categorization...\n');

  let skip = 0;
  let totalModified = 0;
  let totalErrors = 0;

  while (true) {
    // Only process questions not yet categorized (or still on default 'general')
    const questions = await Question.find({
      organization: new mongoose.Types.ObjectId('693b3d8d8004ece0477340c7'), // cripfcnt-school
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

    if (!questions.length) break;

    console.log(`Batch ${Math.floor(skip/BATCH_SIZE) + 1}: processing ${questions.length} questions...`);

    try {
      const results = await categorizeBatch(questions);

      // Build a map: id → result
      const resultMap = {};
      for (const r of results) resultMap[String(r.id)] = r;

      // Bulk write back
      const ops = questions.map(q => {
        const r = resultMap[String(q._id)];
        if (!r) return null;
        return {
          updateOne: {
            filter: { _id: q._id },
            update: { $set: {
              category:   r.category   || 'general',
              categories: [r.category  || 'general'],
              series:     r.series     || 'foundation-series',
              // Only update pillar if Claude disagrees with current module
              // (preserves your existing module field — never overwrites it)
              updatedAt:  new Date()
            }}
          }
        };
      }).filter(Boolean);

      if (ops.length) {
        const result = await Question.bulkWrite(ops);
        totalModified += result.modifiedCount;
        console.log(`  ✓ Modified: ${result.modifiedCount} | Avg confidence: ${
          (results.reduce((s, r) => s + (r.confidence || 0), 0) / results.length).toFixed(2)
        }`);
      }

      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      console.error(`  ✗ Batch failed:`, err.message);
      totalErrors++;
      // Skip this batch and continue
    }

    skip += BATCH_SIZE;
    console.log(`  Total modified so far: ${totalModified}\n`);
  }

  console.log(`\n✅ Done. Total modified: ${totalModified} | Batches failed: ${totalErrors}`);
  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });