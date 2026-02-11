// scripts/categorize-cripfcnt-questions.js - FIXED
// Auto-categorize 9500+ questions for cripfcnt-school
// Run: node scripts/categorize-cripfcnt-questions.js

import mongoose from "mongoose";
import dotenv from "dotenv";
import Question from "../models/question.js";
import Organization from "../models/organization.js";

// Load environment variables
dotenv.config();

// ==============================
// 🧠 MODULE CLASSIFICATION RULES
// ==============================
const MODULE_KEYWORDS = {
  consciousness: [
    'aware', 'perception', 'consciousness', 'self-aware', 'cognition',
    'mindful', 'attention', 'observation', 'recognize', 'realization',
    'insight', 'understanding', 'sense', 'feeling', 'thought process'
  ],
  
  responsibility: [
    'responsible', 'responsibility', 'accountable', 'obligation', 'duty',
    'placement', 'consequence', 'decision', 'choice', 'liability',
    'steward', 'custodian', 'entrust', 'answerable', 'commitment',
    'ownership', 'blame', 'credit', 'experimentation', 'performance'
  ],
  
  interpretation: [
    'interpret', 'interpretation', 'meaning', 'understand', 'context',
    'perspective', 'lens', 'frame', 'narrative', 'story',
    'explain', 'clarify', 'translate', 'decode', 'read between',
    'implication', 'significance', 'intent', 'purpose'
  ],
  
  purpose: [
    'purpose', 'goal', 'aim', 'objective', 'mission', 'vision',
    'direction', 'meaning', 'why', 'reason', 'justification',
    'intention', 'motive', 'aspiration', 'calling', 'function',
    'role', 'contribution', 'legacy', 'impact'
  ],
  
  frequencies: [
    'frequency', 'vibration', 'energy', 'resonance', 'wavelength',
    'oscillation', 'pattern', 'rhythm', 'cycle', 'repetition',
    'signal', 'transmission', 'attunement', 'harmony', 'dissonance',
    'bandwidth', 'spectrum', 'field', 'pulse'
  ],
  
  civilization: [
    'civilization', 'society', 'culture', 'collective', 'community',
    'nation', 'institution', 'system', 'structure', 'order',
    'governance', 'law', 'rule', 'stability', 'progress',
    'infrastructure', 'organization', 'coordination', 'cooperation',
    'social contract', 'civic', 'public', 'common good'
  ],
  
  negotiation: [
    'negotiate', 'negotiation', 'bargain', 'compromise', 'mediate',
    'resolution', 'agreement', 'settlement', 'deal', 'trade-off',
    'concession', 'persuade', 'influence', 'convince', 'dialogue',
    'discussion', 'deliberation', 'consensus', 'diplomacy'
  ],
  
  technology: [
    'technology', 'tool', 'system', 'mechanism', 'process',
    'innovation', 'invention', 'automation', 'efficiency', 'optimization',
    'device', 'instrument', 'machinery', 'digital', 'platform',
    'infrastructure', 'network', 'algorithm', 'data', 'compute'
  ]
};

// ==============================
// 🏷️ TOPIC EXTRACTION PATTERNS
// ==============================
const TOPIC_PATTERNS = {
  'placement': /placement|position|location|situate/i,
  'consequence-management': /consequence|outcome|result|effect|impact/i,
  'decision-frameworks': /decision|choose|select|option|alternative/i,
  'structural-responsibility': /structure|system|framework|architecture/i,
  'blame-vs-responsibility': /blame|fault|guilt|accountability/i,
  'context-reading': /context|situation|circumstance|environment/i,
  'narrative-construction': /narrative|story|account|explanation/i,
  'meaning-extraction': /meaning|significance|import|value/i,
  'perspective-shifts': /perspective|viewpoint|angle|lens/i,
  'goal-alignment': /goal|objective|target|aim/i,
  'function-identification': /function|role|purpose|use/i,
  'mission-clarity': /mission|vision|calling|mandate/i,
  'legacy-planning': /legacy|inheritance|contribution|impact/i,
  'social-contracts': /contract|agreement|covenant|pact/i,
  'governance-models': /govern|rule|manage|administer/i,
  'collective-stability': /stable|stability|balance|equilibrium/i,
  'institutional-trust': /trust|confidence|reliability|faith/i,
  'self-awareness': /self-aware|introspect|reflect|examine/i,
  'attention-direction': /attention|focus|concentrate|aware/i,
  'perception-accuracy': /perceive|sense|detect|observe/i,
  'cognitive-clarity': /clear|clarity|lucid|transparent/i,
  'system-design': /design|architect|plan|blueprint/i,
  'process-optimization': /optimize|improve|enhance|refine/i,
  'tool-selection': /tool|instrument|device|implement/i,
  'automation-ethics': /automate|machine|robot|artificial/i,
  'conflict-resolution': /conflict|dispute|disagree|tension/i,
  'value-exchange': /exchange|trade|swap|barter/i,
  'compromise-frameworks': /compromise|middle-ground|balance/i,
  'persuasion-techniques': /persuade|convince|influence|sway/i,
  'pattern-recognition': /pattern|rhythm|cycle|repetition/i,
  'resonance-tuning': /resonate|tune|align|harmonize/i,
  'signal-clarity': /signal|transmission|broadcast|communicate/i,
  'energy-management': /energy|power|force|vitality/i,
  'performance-metrics': /performance|metric|measure|indicator/i,
  'visibility': /visibility|visible|transparent|observable/i,
  'alignment': /alignment|align|synchronize|coordinate/i,
  'restraint': /restraint|control|discipline|limitation/i
};

// ==============================
// 🎯 SERIES DETECTION
// ==============================
const SERIES_PATTERNS = {
  'foundation-series': /fundamental|basic|foundation|core|essential/i,
  'advanced-placement': /advanced|complex|sophisticated|nuanced/i,
  'case-studies': /example|case|scenario|situation|instance/i,
  'theoretical-frameworks': /theory|model|framework|paradigm|principle/i,
  'practical-application': /apply|implement|execute|practice|action/i,
  'scoi-fundamentals': /scoi|index|metric|measure|indicator/i
};

// ==============================
// 🔍 CLASSIFICATION FUNCTION
// ==============================
function classifyQuestion(questionText, rawText = '') {
  const combinedText = `${questionText} ${rawText}`.toLowerCase();
  
  const result = {
    modules: [],
    topics: [],
    series: null
  };
  
  // Score each module
  const moduleScores = {};
  
  for (const [module, keywords] of Object.entries(MODULE_KEYWORDS)) {
    let score = 0;
    
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(combinedText)) {
        score++;
      }
    }
    
    if (score > 0) {
      moduleScores[module] = score;
    }
  }
  
  // Get top 2 modules
  const sortedModules = Object.entries(moduleScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .filter(([_, score]) => score >= 1)
    .map(([module]) => module);
  
  result.modules = sortedModules.length > 0 ? sortedModules : ['general'];
  
  // Extract topics
  for (const [topic, pattern] of Object.entries(TOPIC_PATTERNS)) {
    if (pattern.test(combinedText)) {
      result.topics.push(topic);
    }
  }
  
  // Detect series
  for (const [series, pattern] of Object.entries(SERIES_PATTERNS)) {
    if (pattern.test(combinedText)) {
      result.series = series;
      break;
    }
  }
  
  return result;
}

// ==============================
// 🚀 MAIN CATEGORIZATION SCRIPT
// ==============================
async function categorizeCripfcntQuestions() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    
    if (!mongoUri) {
      throw new Error('MONGO_URI or MONGODB_URI not found in environment variables');
    }
    
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');
    
    // Find org
    const org = await Organization.findOne({ slug: 'cripfcnt-school' }).lean();
    
    if (!org) {
      throw new Error('Organization "cripfcnt-school" not found. Run verify-setup.js first.');
    }
    
    console.log(`\n📚 Using organization: ${org.name} (${org._id})`);
    
    // Find questions
    const questions = await Question.find({
      organization: org._id,
      type: { $ne: 'comprehension' }
    })
    .select('_id text raw module')
    .lean();
    
    console.log(`\n📊 Found ${questions.length} questions to categorize\n`);
    
    if (questions.length === 0) {
      console.log('⚠️  No questions found. Run verify-setup.js to diagnose.');
      return;
    }
    
    // Process in batches
    const BATCH_SIZE = 100;
    let processed = 0;
    let updated = 0;
    
    for (let i = 0; i < questions.length; i += BATCH_SIZE) {
      const batch = questions.slice(i, i + BATCH_SIZE);
      const bulkOps = [];
      
      for (const q of batch) {
        const classification = classifyQuestion(q.text, q.raw || '');
        
        if (classification.modules.length > 0 || classification.topics.length > 0) {
          bulkOps.push({
            updateOne: {
              filter: { _id: q._id },
              update: {
                $set: {
                  modules: classification.modules,
                  topics: classification.topics,
                  series: classification.series,
                  updatedAt: new Date()
                }
              }
            }
          });
          updated++;
        }
        
        processed++;
      }
      
      if (bulkOps.length > 0) {
        await Question.bulkWrite(bulkOps);
      }
      
      console.log(`✅ Processed ${processed}/${questions.length} (${updated} updated)`);
    }
    
    // Summary
    console.log('\n📊 CATEGORIZATION SUMMARY:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    for (const module of Object.keys(MODULE_KEYWORDS)) {
      const count = await Question.countDocuments({
        organization: org._id,
        modules: module
      });
      console.log(`📌 ${module.toUpperCase()}: ${count} questions`);
    }
    
    const generalCount = await Question.countDocuments({
      organization: org._id,
      modules: 'general'
    });
    console.log(`📌 GENERAL: ${generalCount} questions`);
    
    console.log(`\n✅ Complete! Updated ${updated}/${questions.length} questions\n`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run
categorizeCripfcntQuestions()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });