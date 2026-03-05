// scripts/tag_home_questions_v2.js
/**
 * AI-Powered Question Tagging for cripfcnt-home (Enhanced)
 * 
 * Tags all cripfcnt-home child questions with:
 * - topic (micro-topic like "fractions", "verb-tenses", "photosynthesis")
 * - difficulty (1-5 scale)
 * - subject (math, english, science, responsibility, computerstudies, history, geography)
 * - grade (1-7)
 * 
 * Only updates questions that DON'T have topic assigned yet.
 * 
 * Usage:
 *   node scripts/tag_home_questions_v2.js
 * 
 * Options:
 *   --batch-size=15    Questions per batch (default: 15)
 *   --subject=math     Only tag specific subject
 *   --grade=4          Only tag specific grade
 *   --dry-run          Preview without saving
 *   --force            Re-tag questions even if they have topics
 */

import mongoose from "mongoose";
import Question from "../models/question.js";
import Organization from "../models/organization.js";
import dotenv from "dotenv";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const BATCH_SIZE = parseInt(process.argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1]) || 15;
const TARGET_SUBJECT = process.argv.find(arg => arg.startsWith('--subject='))?.split('=')[1];
const TARGET_GRADE = process.argv.find(arg => arg.startsWith('--grade='))?.split('=')[1];
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const HOME_ORG_SLUG = "cripfcnt-home";

/**
 * Enhanced subject mapping for better AI recognition
 */
const SUBJECT_ALIASES = {
  'mathematics': 'math',
  'maths': 'math',
  'arithmetic': 'math',
  
  'language': 'english',
  'literacy': 'english',
  'reading': 'english',
  
  'biology': 'science',
  'physics': 'science',
  'chemistry': 'science',
  
  'computing': 'computerstudies',
  'computer science': 'computerstudies',
  'ict': 'computerstudies',
  'technology': 'computerstudies',
  
  'social studies': 'history',
  'civics': 'responsibility',
  'ethics': 'responsibility',
  'moral education': 'responsibility'
};

/**
 * Tag questions using Claude AI with enhanced subject support
 */
async function tagQuestionsBatch(questions) {
  if (!ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY not found in .env");
    throw new Error("API key required");
  }

  const questionsForAI = questions.map((q, idx) => ({
    id: idx,
    text: q.text,
    choices: q.choices ? q.choices.map(c => c.text || c) : [],
    currentSubject: q.subject || q.module || 'unknown'
  }));

  const prompt = `You are tagging quiz questions for Zimbabwean primary school students (Grades 1-7).

Tag each question with:
1. "topic" - Specific micro-topic in kebab-case (e.g., "fractions", "multiplication-tables", "verb-tenses", "photosynthesis", "keyboard-skills", "ancient-civilizations")
2. "difficulty" - Number 1-5:
   - 1 = Very Easy (Grade 1-2 level, basic recall)
   - 2 = Easy (Grade 3-4 level, simple application)
   - 3 = Medium (Grade 4-5 level, requires thinking)
   - 4 = Hard (Grade 6-7 level, complex reasoning)
   - 5 = Very Hard (Advanced, multi-step problems)
3. "subject" - MUST be one of: math, english, science, responsibility, computerstudies, history, geography
4. "grade" - Estimated grade level 1-7

SUBJECT GUIDANCE:
- math: arithmetic, algebra, geometry, fractions, decimals, measurements
- english: grammar, reading comprehension, vocabulary, writing, spelling
- science: biology, physics, chemistry, nature, experiments, body systems
- computerstudies: typing, computer basics, internet safety, coding concepts
- history: past events, historical figures, timelines, ancient civilizations
- geography: maps, continents, countries, physical features, climate
- responsibility: ethics, honesty, teamwork, decision-making, character building

Questions:
${JSON.stringify(questionsForAI, null, 2)}

Respond ONLY with JSON array (no markdown, no backticks, no explanation):
[
  {
    "id": 0,
    "topic": "addition-basic",
    "difficulty": 1,
    "subject": "math",
    "grade": 2
  }
]`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: prompt
        }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const content = data.content[0].text;
    
    // Extract JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("Raw AI response:", content);
      throw new Error("No JSON array in AI response");
    }

    const tags = JSON.parse(jsonMatch[0]);

    // Normalize subjects using aliases
    const updates = [];
    for (let i = 0; i < questions.length; i++) {
      const tag = tags.find(t => t.id === i);
      if (tag) {
        let normalizedSubject = tag.subject ? tag.subject.toLowerCase() : 'math';
        
        // Apply alias mapping
        if (SUBJECT_ALIASES[normalizedSubject]) {
          normalizedSubject = SUBJECT_ALIASES[normalizedSubject];
        }
        
        // Fallback to valid subjects only
        const validSubjects = ['math', 'english', 'science', 'responsibility', 'computerstudies', 'history', 'geography'];
        if (!validSubjects.includes(normalizedSubject)) {
          console.warn(`   ⚠️  Invalid subject "${normalizedSubject}" for question ${i}, using current: ${questions[i].subject || 'math'}`);
          normalizedSubject = questions[i].subject || questions[i].module || 'math';
        }
        
        updates.push({
          questionId: questions[i]._id,
          topic: tag.topic ? tag.topic.toLowerCase().replace(/\s+/g, '-') : null,
          difficulty: Math.min(5, Math.max(1, tag.difficulty || 3)),
          subject: normalizedSubject,
          grade: Math.min(7, Math.max(1, tag.grade || questions[i].grade || 4))
        });
      }
    }

    return updates;

  } catch (error) {
    console.error("Error calling Claude API:", error.message);
    throw error;
  }
}

/**
 * Main tagging process
 */
async function tagAllQuestions() {
  try {
    console.log("🚀 Starting cripfcnt-home question tagging (Enhanced v2)...");
    console.log(`📊 Batch size: ${BATCH_SIZE}`);
    if (TARGET_SUBJECT) {
      console.log(`🎯 Target subject: ${TARGET_SUBJECT}`);
    }
    if (TARGET_GRADE) {
      console.log(`🎯 Target grade: ${TARGET_GRADE}`);
    }
    if (FORCE) {
      console.log(`🔄 FORCE mode - Re-tagging all questions`);
    }
    if (DRY_RUN) {
      console.log("🔍 DRY RUN MODE - No changes will be saved");
    }
    console.log("");

    // Connect to DB
    if (!mongoose.connection.readyState) {
      const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
      if (!mongoUri) {
        throw new Error("MONGODB_URI not found in .env");
      }
      await mongoose.connect(mongoUri);
      console.log("✅ Connected to database");
    }

    // Get cripfcnt-home org
    const org = await Organization.findOne({ slug: HOME_ORG_SLUG });
    if (!org) {
      throw new Error(`Organization ${HOME_ORG_SLUG} not found`);
    }

    console.log(`✅ Found org: ${org.name} (${org._id})`);

    // Build query for child questions only (not comprehension parents)
    const query = {
      organization: org._id,
      type: { $ne: "comprehension" }
    };

    // ✅ ONLY UPDATE QUESTIONS WITHOUT TOPICS (unless --force)
    if (!FORCE) {
      query.$or = [
        { topic: { $exists: false } },
        { topic: null },
        { topic: "" }
      ];
    }

    if (TARGET_SUBJECT) {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { subject: TARGET_SUBJECT.toLowerCase() },
          { module: TARGET_SUBJECT.toLowerCase() }
        ]
      });
    }

    if (TARGET_GRADE) {
      query.grade = parseInt(TARGET_GRADE);
    }

    const totalCount = await Question.countDocuments(query);
    console.log(`📝 Found ${totalCount} questions to tag\n`);

    if (totalCount === 0) {
      console.log("✨ All questions are already tagged!");
      console.log("   Use --force to re-tag questions");
      return;
    }

    // Get subject breakdown
    const subjects = await Question.aggregate([
      { $match: query },
      { 
        $group: { 
          _id: { $ifNull: ["$subject", "$module"] }, 
          count: { $sum: 1 } 
        } 
      },
      { $sort: { count: -1 } }
    ]);

    console.log("📊 Questions by subject:");
    subjects.forEach(s => {
      console.log(`   ${s._id || 'unknown'}: ${s.count} questions`);
    });
    console.log("");

    let processedCount = 0;
    let successCount = 0;
    let errorCount = 0;

    // Process in batches
    while (processedCount < totalCount) {
      const questions = await Question.find(query)
        .limit(BATCH_SIZE)
        .lean();

      if (questions.length === 0) break;

      const batchNum = Math.floor(processedCount / BATCH_SIZE) + 1;
      console.log(`\n📦 Batch ${batchNum}/${Math.ceil(totalCount / BATCH_SIZE)}`);
      console.log(`   Questions ${processedCount + 1} to ${processedCount + questions.length}`);

      // Show sample question
      if (questions.length > 0) {
        const sample = questions[0];
        console.log(`   Sample: "${sample.text?.substring(0, 60)}..." (${sample.subject || sample.module || 'unknown'})`);
      }

      try {
        console.log("   🤖 Calling Claude AI...");
        const updates = await tagQuestionsBatch(questions);

        console.log(`   ✅ Received ${updates.length} tags`);

        if (!DRY_RUN) {
          // Apply updates
          let updated = 0;
          for (const update of updates) {
            const result = await Question.updateOne(
              { _id: update.questionId },
              {
                $set: {
                  topic: update.topic,
                  difficulty: update.difficulty,
                  subject: update.subject,
                  grade: update.grade
                }
              }
            );
            if (result.modifiedCount > 0) updated++;
          }
          console.log(`   💾 Updated ${updated} questions in database`);
          successCount += updated;
        } else {
          console.log("   🔍 DRY RUN - Sample tags:");
          updates.slice(0, 5).forEach(u => {
            const q = questions.find(qq => String(qq._id) === String(u.questionId));
            console.log(`      [${u.subject}] Grade ${u.grade} · ${u.topic} (diff: ${u.difficulty}/5)`);
            console.log(`         Q: ${q?.text?.substring(0, 50)}...`);
          });
          successCount += updates.length;
        }

        processedCount += questions.length;

        // Rate limit delay (avoid hitting API limits)
        if (processedCount < totalCount) {
          console.log("   ⏳ Waiting 2 seconds...");
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

      } catch (error) {
        console.error(`   ❌ Error:`, error.message);
        errorCount += questions.length;
        processedCount += questions.length;
        
        // Longer delay on error
        console.log("   ⏳ Waiting 5 seconds after error...");
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Summary
    console.log("\n" + "=".repeat(70));
    console.log("📊 TAGGING SUMMARY");
    console.log("=".repeat(70));
    console.log(`Total questions found: ${totalCount}`);
    console.log(`Successfully tagged: ${successCount} (${Math.round((successCount / totalCount) * 100)}%)`);
    console.log(`Errors: ${errorCount}`);
    
    if (DRY_RUN) {
      console.log("\n🔍 This was a DRY RUN - no changes saved");
      console.log("Run without --dry-run to apply changes:");
      console.log("   node scripts/tag_home_questions_v2.js");
    } else {
      console.log("\n✅ Changes saved to database");
    }

    console.log("\n✨ Tagging complete!");

    // Show next steps
    if (errorCount > 0) {
      console.log("\n⚠️  Some questions failed. You can:");
      console.log("   1. Re-run this script (it will skip already tagged questions)");
      console.log("   2. Check API credits at https://console.anthropic.com");
      console.log("   3. Use --batch-size=10 for smaller batches");
    }

  } catch (error) {
    console.error("\n❌ Fatal error:", error);
    console.error(error.stack);
    throw error;
  } finally {
    if (mongoose.connection.readyState) {
      await mongoose.disconnect();
      console.log("\n👋 Disconnected from database");
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  tagAllQuestions()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

export { tagAllQuestions };