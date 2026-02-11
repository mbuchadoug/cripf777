// scripts/categorize-cripfcnt-questions.js
// Auto-categorize 9500+ questions for cripfcnt-school
// Run: node scripts/categorize-cripfcnt-questions.js

import mongoose from "mongoose";
import Question from "../models/question.js";
import Organization from "../models/organization.js";

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
    'ownership', 'blame', 'credit', 'experimentation'
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
  // Responsibility topics
  'placement': /placement|position|location|situate/i,
  'consequence-management': /consequence|outcome|result|effect|impact/i,
  'decision-frameworks': /decision|choose|select|option|alternative/i,
  'structural-responsibility': /structure|system|framework|architecture/i,
  'blame-vs-responsibility': /blame|fault|guilt|accountability/i,
  
  // Interpretation topics
  'context-reading': /context|situation|circumstance|environment/i,
  'narrative-construction': /narrative|story|account|explanation/i,
  'meaning-extraction': /meaning|significance|import|value/i,
  'perspective-shifts': /perspective|viewpoint|angle|lens/i,
  
  // Purpose topics
  'goal-alignment': /goal|objective|target|aim/i,
  'function-identification': /function|role|purpose|use/i,
  'mission-clarity': /mission|vision|calling|mandate/i,
  'legacy-planning': /legacy|inheritance|contribution|impact/i,
  
  // Civilization topics
  'social-contracts': /contract|agreement|covenant|pact/i,
  'governance-models': /govern|rule|manage|administer/i,
  'collective-stability': /stable|stability|balance|equilibrium/i,
  'institutional-trust': /trust|confidence|reliability|faith/i,
  
  // Consciousness topics
  'self-awareness': /self-aware|introspect|reflect|examine/i,
  'attention-direction': /attention|focus|concentrate|aware/i,
  'perception-accuracy': /perceive|sense|detect|observe/i,
  'cognitive-clarity': /clear|clarity|lucid|transparent/i,
  
  // Technology topics
  'system-design': /design|architect|plan|blueprint/i,
  'process-optimization': /optimize|improve|enhance|refine/i,
  'tool-selection': /tool|instrument|device|implement/i,
  'automation-ethics': /automate|machine|robot|artificial/i,
  
  // Negotiation topics
  'conflict-resolution': /conflict|dispute|disagree|tension/i,
  'value-exchange': /exchange|trade|swap|barter/i,
  'compromise-frameworks': /compromise|middle-ground|balance/i,
  'persuasion-techniques': /persuade|convince|influence|sway/i,
  
  // Frequencies topics
  'pattern-recognition': /pattern|rhythm|cycle|repetition/i,
  'resonance-tuning': /resonate|tune|align|harmonize/i,
  'signal-clarity': /signal|transmission|broadcast|communicate/i,
  'energy-management': /energy|power|force|vitality/i
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
  
  // Get top 2 modules (questions can belong to multiple modules)
  const sortedModules = Object.entries(moduleScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .filter(([_, score]) => score >= 1) // at least 1 keyword match
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
      break; // only one series per question
    }
  }
  
  return result;
}

// ==============================
// 🚀 MAIN CATEGORIZATION SCRIPT
// ==============================
async function categorizeCripfcntQuestions() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/lms');
    console.log('✅ Connected to MongoDB');
    
    // Find cripfcnt-school org
    const org = await Organization.findOne({ slug: 'cripfcnt-school' }).lean();
    if (!org) {
      throw new Error('cripfcnt-school organization not found');
    }
    
    console.log(`📚 Found organization: ${org.name} (${org._id})`);
    
    // Find all questions for this org
    const questions = await Question.find({
      organization: org._id,
      type: { $ne: 'comprehension' } // skip parent passages
    })
    .select('_id text raw module')
    .lean();
    
    console.log(`📊 Found ${questions.length} questions to categorize`);
    
    if (questions.length === 0) {
      console.log('⚠️  No questions found. Exiting.');
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
        
        // Only update if we found modules/topics
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
      
      // Execute batch update
      if (bulkOps.length > 0) {
        await Question.bulkWrite(bulkOps);
      }
      
      console.log(`✅ Processed ${processed}/${questions.length} questions (${updated} updated)`);
    }
    
    // Generate summary statistics
    console.log('\n📊 CATEGORIZATION SUMMARY:');
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
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
    console.log(`📌 GENERAL (uncategorized): ${generalCount} questions`);
    
    console.log(`\n✅ Categorization complete! Updated ${updated}/${questions.length} questions`);
    
  } catch (error) {
    console.error('❌ Error during categorization:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  categorizeCripfcntQuestions()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

export default categorizeCripfcntQuestions;