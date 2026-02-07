// scripts/tag_cripfcnt_home_questions.js
/**
 * AI-Powered Question Tagging for cripfcnt-home
 * 
 * Tags all cripfcnt-home questions with:
 * - topic (micro-topic like "fractions", "verb-tenses")
 * - difficulty (1-5 scale)
 * - subject (math, english, science, responsibility)
 * 
 * Usage:
 *   node scripts/tag_cripfcnt_home_questions.js
 * 
 * Options:
 *   --batch-size=20    Questions per batch (default: 20)
 *   --subject=math     Only tag specific subject
 *   --dry-run          Preview without saving
 */

import mongoose from "mongoose";
import Question from "../models/question.js";
import Organization from "../models/organization.js";
import dotenv from "dotenv";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const BATCH_SIZE = parseInt(process.argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1]) || 20;
const TARGET_SUBJECT = process.argv.find(arg => arg.startsWith('--subject='))?.split('=')[1];
const DRY_RUN = process.argv.includes('--dry-run');
const HOME_ORG_SLUG = "cripfcnt-home";

/**
 * Tag questions using Claude AI
 */
async function tagQuestionsBatch(questions) {
  if (!ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY not found");
    throw new Error("API key required");
  }

  const questionsForAI = questions.map((q, idx) => ({
    id: idx,
    text: q.text,
    choices: q.choices ? q.choices.map(c => c.text || c) : []
  }));

  const prompt = `You are tagging quiz questions for Zimbabwean primary school students (Grades 1-7).

Tag each question with:
1. "topic" - Specific micro-topic (e.g., "fractions", "multiplication-tables", "verb-tenses", "photosynthesis", "honesty")
2. "difficulty" - Number 1-5:
   - 1 = Very Easy (Grade 1-2 level, basic recall)
   - 2 = Easy (Grade 3-4 level, simple application)
   - 3 = Medium (Grade 4-5 level, requires thinking)
   - 4 = Hard (Grade 6-7 level, complex reasoning)
   - 5 = Very Hard (Advanced, multi-step problems)
3. "subject" - One of: math, english, science, responsibility
4. "grade" - Estimated grade level 1-7

Questions:
${JSON.stringify(questionsForAI, null, 2)}

Respond ONLY with JSON array (no markdown):
[
  {
    "id": 0,
    "topic": "addition",
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
    
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("No JSON array in AI response");
    }

    const tags = JSON.parse(jsonMatch[0]);

    const updates = [];
    for (let i = 0; i < questions.length; i++) {
      const tag = tags.find(t => t.id === i);
      if (tag) {
        updates.push({
          questionId: questions[i]._id,
          topic: tag.topic,
          difficulty: tag.difficulty,
          subject: tag.subject,
          grade: tag.grade
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
    console.log("🚀 Starting cripfcnt-home question tagging...");
    console.log(`📊 Batch size: ${BATCH_SIZE}`);
    if (TARGET_SUBJECT) {
      console.log(`🎯 Target subject: ${TARGET_SUBJECT}`);
    }
    if (DRY_RUN) {
      console.log("🔍 DRY RUN MODE - No changes will be saved");
    }
    console.log("");

    // Connect to DB
    if (!mongoose.connection.readyState) {
      const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
      if (!mongoUri) {
        throw new Error("MONGODB_URI not found");
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
      type: { $ne: "comprehension" },
      $or: [
        { topic: { $exists: false } },
        { topic: null },
        { difficulty: { $exists: false } },
        { difficulty: null },
        { subject: { $exists: false } },
        { subject: null }
      ]
    };

    if (TARGET_SUBJECT) {
      // If subject filter specified, also include questions that need updating
      query.$and = [{ module: TARGET_SUBJECT }];
    }

    const totalCount = await Question.countDocuments(query);
    console.log(`📝 Found ${totalCount} questions to tag\n`);

    if (totalCount === 0) {
      console.log("✨ All questions are already tagged!");
      return;
    }

    let processedCount = 0;
    let successCount = 0;
    let errorCount = 0;

    // Process in batches
    while (processedCount < totalCount) {
      const questions = await Question.find(query)
        .limit(BATCH_SIZE)
        .lean();

      if (questions.length === 0) break;

      console.log(`\n📦 Batch ${Math.floor(processedCount / BATCH_SIZE) + 1}`);
      console.log(`   Questions ${processedCount + 1} to ${processedCount + questions.length}`);

      try {
        console.log("   🤖 Calling Claude AI...");
        const updates = await tagQuestionsBatch(questions);

        console.log(`   ✅ Received ${updates.length} tags`);

        if (!DRY_RUN) {
          // Apply updates
          for (const update of updates) {
            await Question.updateOne(
              { _id: update.questionId },
              {
                $set: {
                  topic: update.topic ? update.topic.toLowerCase() : null,
                  difficulty: update.difficulty,
                  subject: update.subject ? update.subject.toLowerCase() : null,
                  grade: update.grade
                }
              }
            );
          }
          console.log(`   💾 Updated ${updates.length} questions`);
          successCount += updates.length;
        } else {
          console.log("   🔍 DRY RUN - Sample tags:");
          updates.slice(0, 3).forEach(u => {
            console.log(`      Grade ${u.grade} ${u.subject}: ${u.topic} (difficulty ${u.difficulty}/5)`);
          });
          successCount += updates.length;
        }

        processedCount += questions.length;

        // Rate limit delay
        if (processedCount < totalCount) {
          console.log("   ⏳ Waiting 1 second...");
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

      } catch (error) {
        console.error(`   ❌ Error:`, error.message);
        errorCount += questions.length;
        processedCount += questions.length;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 TAGGING SUMMARY");
    console.log("=".repeat(60));
    console.log(`Total questions: ${totalCount}`);
    console.log(`Successfully tagged: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Success rate: ${Math.round((successCount / totalCount) * 100)}%`);
    
    if (DRY_RUN) {
      console.log("\n🔍 This was a DRY RUN - no changes saved");
      console.log("Run without --dry-run to apply changes");
    }

    console.log("\n✨ Tagging complete!");

  } catch (error) {
    console.error("\n❌ Fatal error:", error);
    throw error;
  } finally {
    if (mongoose.connection.readyState) {
      await mongoose.disconnect();
      console.log("👋 Disconnected from database");
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
