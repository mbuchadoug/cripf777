// scripts/tag_active_quiz_questions_only.js
/**
 * Tags ONLY questions that are currently assigned in ExamInstances
 * This saves API costs by skipping unused questions
 */

import mongoose from "mongoose";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import Organization from "../models/organization.js";
import dotenv from "dotenv";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BATCH_SIZE = 50;
const ORG_SLUG = 'cripfcnt-home';

async function tagQuestionsBatch(questions) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not found in environment");
  }

  const questionsForAI = questions.map((q, idx) => ({
    id: idx,
    text: q.text,
    subject: q.subject || q.module || "general",
    grade: q.grade,
    choices: q.choices ? q.choices.map(c => c.text || c) : []
  }));

  const prompt = `You are an educational content tagger. Analyze these quiz questions and tag each with:
1. "topic" - A specific micro-topic (e.g., "fractions", "multiplication", "verb-tenses", "reading-comprehension")
2. "difficulty" - A number from 1-5
3. "subject" - Main subject (math, english, science, responsibility, etc.)

Questions to tag:
${JSON.stringify(questionsForAI, null, 2)}

Respond ONLY with a JSON array (no markdown, no explanation) in this exact format:
[
  { "id": 0, "topic": "fractions", "difficulty": 2, "subject": "math" },
  { "id": 1, "topic": "verb-tenses", "difficulty": 3, "subject": "english" }
]`;

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
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const aiResponse = data.content[0].text;

  let jsonText = aiResponse.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
  }

  const tags = JSON.parse(jsonText);

  return tags.map(tag => ({
    id: questions[tag.id]._id,
    topic: tag.topic.toLowerCase().trim(),
    difficulty: Math.min(5, Math.max(1, tag.difficulty)),
    subject: tag.subject.toLowerCase().trim()
  }));
}

async function main() {
  try {
    console.log("\n🎯 Smart Question Tagger (Active Quizzes Only)");
    console.log("===============================================");
    console.log(`🏢 Organization: ${ORG_SLUG}\n`);

    // Connect to database
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to database\n");

    // Find organization
    const Organization = mongoose.model('Organization', new mongoose.Schema({
      name: String,
      slug: String
    }), 'organizations');
    
    const homeOrg = await Organization.findOne({ slug: ORG_SLUG });
    if (!homeOrg) {
      console.error(`❌ Organization "${ORG_SLUG}" not found`);
      process.exit(1);
    }
    
    console.log(`✅ Found: ${homeOrg.name}`);
    console.log(`   ID: ${homeOrg._id}\n`);

    // Step 1: Find all active ExamInstances
    console.log("🔍 Finding active quizzes...");
    const exams = await ExamInstance.find({ 
      org: homeOrg._id 
    }).select('questionIds').lean();
    
    console.log(`   Found ${exams.length} exam instances\n`);

    // Step 2: Extract all unique question IDs from active exams
    const activeQuestionIds = new Set();
    
    for (const exam of exams) {
      if (!Array.isArray(exam.questionIds)) continue;
      
      for (const qid of exam.questionIds) {
        const qidStr = String(qid);
        
        // Skip parent markers
        if (qidStr.startsWith('parent:')) {
          const parentId = qidStr.split(':')[1];
          if (mongoose.isValidObjectId(parentId)) {
            activeQuestionIds.add(parentId);
          }
          continue;
        }
        
        if (mongoose.isValidObjectId(qidStr)) {
          activeQuestionIds.add(qidStr);
        }
      }
    }

    console.log(`📊 Found ${activeQuestionIds.size} unique questions in active quizzes\n`);

    // Step 3: Find which of these questions need tagging
    const untaggedQuery = {
      _id: { $in: Array.from(activeQuestionIds) },
      organization: homeOrg._id,
      type: { $ne: "comprehension" },
      $or: [
        { topic: { $exists: false } },
        { topic: null }
      ]
    };

    const untaggedCount = await Question.countDocuments(untaggedQuery);
    
    console.log(`🎯 Questions that NEED tagging: ${untaggedCount}`);
    
    if (untaggedCount === 0) {
      console.log("\n✨ All active quiz questions are already tagged!");
      console.log("   Your Knowledge Map should work now!\n");
      process.exit(0);
    }

    const estimatedCost = (untaggedCount / 50) * 0.10;
    console.log(`💰 Estimated cost: $${estimatedCost.toFixed(2)}`);
    console.log(`   Your balance: $3.13`);
    
    if (estimatedCost > 3) {
      console.log("\n⚠️  WARNING: This might exceed your balance!");
      console.log("   Consider tagging in batches with --limit flag\n");
    } else {
      console.log("   ✅ You have enough credits!\n");
    }

    // Step 4: Tag the questions
    let processedCount = 0;
    let successCount = 0;

    while (processedCount < untaggedCount) {
      const questions = await Question.find(untaggedQuery)
        .limit(BATCH_SIZE)
        .lean();

      if (questions.length === 0) break;

      const batchNum = Math.floor(processedCount / BATCH_SIZE) + 1;
      console.log(`\n📦 Batch ${batchNum}/${Math.ceil(untaggedCount / BATCH_SIZE)}`);
      console.log(`   Questions ${processedCount + 1} to ${processedCount + questions.length}`);

      try {
        console.log("   🤖 Calling Claude AI...");
        const updates = await tagQuestionsBatch(questions);
        console.log(`   ✅ Received ${updates.length} tags`);

        const result = await Question.bulkUpdateTopicsAndDifficulty(updates);
        console.log(`   💾 Updated ${result.modifiedCount} questions`);
        
        successCount += result.modifiedCount;
        processedCount += questions.length;

        // Rate limiting
        if (processedCount < untaggedCount) {
          console.log("   ⏳ Waiting 1 second...");
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

      } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        processedCount += questions.length;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    console.log("\n" + "=".repeat(50));
    console.log("🎉 TAGGING COMPLETE!\n");
    console.log(`✅ Successfully tagged: ${successCount} questions`);
    console.log(`📊 Total processed: ${processedCount} questions`);
    console.log("\n✨ Your Knowledge Map should now work!\n");
    console.log("Next steps:");
    console.log("  1. Take a NEW quiz as student");
    console.log("  2. View Knowledge Map as parent");
    console.log("  3. See topic progress! 🎯\n");

  } catch (error) {
    console.error("\n❌ Fatal error:", error);
    process.exit(1);
  } finally {
    if (mongoose.connection.readyState) {
      await mongoose.connection.close();
    }
  }
}

main().catch(console.error);