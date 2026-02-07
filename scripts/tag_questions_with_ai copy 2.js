// scripts/tag_questions_with_ai.js
/**
 * AI-Powered Question Tagging Script
 * 
 * This script uses Claude AI to automatically tag all existing questions with:
 * - topic (micro-topic like "fractions", "verb-tenses")
 * - difficulty (1-5 scale)
 * - subject (math, english, science, etc.)
 * 
 * Usage:
 *   node scripts/tag_questions_with_ai.js
 * 
 * Options:
 *   --batch-size=50    Number of questions to process per batch
 *   --subject=math     Only process questions for specific subject
 *   --dry-run          Preview changes without saving
 */

import mongoose from "mongoose";
import Question from "../models/question.js";
import dotenv from "dotenv";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const BATCH_SIZE = parseInt(process.argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1]) || 50;
const TARGET_SUBJECT = process.argv.find(arg => arg.startsWith('--subject='))?.split('=')[1];
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Tag a batch of questions using Claude AI
 */
async function tagQuestionsBatch(questions) {
  if (!ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY not found in environment");
    console.error("Please set either ANTHROPIC_API_KEY or CLAUDE_API_KEY in your .env file");
    throw new Error("API key required");
  }

  // Prepare questions for AI
  const questionsForAI = questions.map((q, idx) => ({
    id: idx,
    text: q.text,
    subject: q.subject || q.module || "general",
    grade: q.grade,
    choices: q.choices ? q.choices.map(c => c.text || c) : []
  }));

  const prompt = `You are an educational content tagger. Analyze these quiz questions and tag each with:
1. "topic" - A specific micro-topic (e.g., "fractions", "multiplication", "verb-tenses", "photosynthesis")
2. "difficulty" - A number from 1-5 where:
   - 1 = Very Easy (basic recall, simple concepts)
   - 2 = Easy (straightforward application)
   - 3 = Medium (requires understanding and thinking)
   - 4 = Hard (complex problem-solving)
   - 5 = Very Hard (advanced concepts, multi-step reasoning)
3. "subject" - Main subject (math, english, science, social-studies, responsibility, etc.)

Questions to tag:
${JSON.stringify(questionsForAI, null, 2)}

Respond ONLY with a JSON array (no markdown, no explanation) in this exact format:
[
  {
    "id": 0,
    "topic": "fractions",
    "difficulty": 2,
    "subject": "math"
  },
  {
    "id": 1,
    "topic": "verb-tenses",
    "difficulty": 3,
    "subject": "english"
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
      throw new Error(`API request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const content = data.content[0].text;
    
    // Extract JSON from response (handle markdown fences)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("No JSON array found in AI response");
    }

    const tags = JSON.parse(jsonMatch[0]);

    // Map tags back to questions
    const updates = [];
    for (let i = 0; i < questions.length; i++) {
      const tag = tags.find(t => t.id === i);
      if (tag) {
        updates.push({
          questionId: questions[i]._id,
          topic: tag.topic,
          difficulty: tag.difficulty,
          subject: tag.subject
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
    console.log("🚀 Starting question tagging process...");
    console.log(`📊 Batch size: ${BATCH_SIZE}`);
    if (TARGET_SUBJECT) {
      console.log(`🎯 Target subject: ${TARGET_SUBJECT}`);
    }
    if (DRY_RUN) {
      console.log("🔍 DRY RUN MODE - No changes will be saved");
    }
    console.log("");

    // Connect to database
    if (!mongoose.connection.readyState) {
      const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
      if (!mongoUri) {
        throw new Error("MONGODB_URI not found in environment");
      }
      await mongoose.connect(mongoUri);
      console.log("✅ Connected to database");
    }

    // Build query
    const query = {
      type: { $ne: "comprehension" }, // Only tag regular questions
      $or: [
        { topic: { $exists: false } },
        { topic: null },
        { difficulty: { $exists: false } },
        { difficulty: null }
      ]
    };

    if (TARGET_SUBJECT) {
      query.$or.push(
        { subject: TARGET_SUBJECT },
        { module: TARGET_SUBJECT }
      );
    }

    // Count questions to tag
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

      console.log(`\n📦 Processing batch ${Math.floor(processedCount / BATCH_SIZE) + 1}...`);
      console.log(`   Questions ${processedCount + 1} to ${processedCount + questions.length}`);

      try {
        // Tag questions with AI
        console.log("   🤖 Calling Claude AI...");
        const updates = await tagQuestionsBatch(questions);

        console.log(`   ✅ Received ${updates.length} tags from AI`);

        if (!DRY_RUN) {
          // Apply updates to database
          const result = await Question.bulkUpdateTopicsAndDifficulty(updates);
          console.log(`   💾 Updated ${result.modifiedCount} questions in database`);
          successCount += result.modifiedCount;
        } else {
          console.log("   🔍 DRY RUN - Sample tags:");
          updates.slice(0, 3).forEach(u => {
            console.log(`      ${u.topic} (${u.difficulty}/5) - ${u.subject}`);
          });
          successCount += updates.length;
        }

        processedCount += questions.length;

        // Rate limiting delay (1 second between batches)
        if (processedCount < totalCount) {
          console.log("   ⏳ Waiting 1 second before next batch...");
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

      } catch (error) {
        console.error(`   ❌ Error processing batch:`, error.message);
        errorCount += questions.length;
        processedCount += questions.length;
        
        // Continue with next batch
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
      console.log("\n🔍 This was a DRY RUN - no changes were saved");
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

/**
 * Run if called directly
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  tagAllQuestions()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

export { tagAllQuestions, tagQuestionsBatch };
