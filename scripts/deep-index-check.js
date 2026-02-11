// scripts/deep-index-check.js
// Find and fix ALL indexes with parallel arrays

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

async function deepIndexCheck() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');
    
    const db = mongoose.connection.db;
    const collection = db.collection('questions');
    
    // Get ALL indexes
    console.log('📋 ALL INDEXES ON QUESTIONS COLLECTION:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const indexes = await collection.indexes();
    
    const problematic = [];
    
    indexes.forEach((idx, i) => {
      const keys = Object.keys(idx.key);
      const hasModules = keys.includes('modules');
      const hasTopics = keys.includes('topics');
      const hasBothArrays = hasModules && hasTopics;
      
      console.log(`${i + 1}. ${idx.name}`);
      console.log(`   Keys: ${JSON.stringify(idx.key)}`);
      console.log(`   Unique: ${idx.unique || false}`);
      console.log(`   Background: ${idx.background || false}`);
      
      if (hasBothArrays) {
        console.log('   ⚠️  ⚠️  ⚠️  PROBLEMATIC - HAS BOTH MODULES AND TOPICS ⚠️  ⚠️  ⚠️');
        problematic.push(idx);
      }
      
      console.log('');
    });
    
    if (problematic.length === 0) {
      console.log('✅ No problematic indexes found!\n');
      console.log('🔍 But the error persists. Let me check for hidden issues...\n');
      
      // Check if any document has both modules and topics as arrays
      const sampleDoc = await collection.findOne({
        modules: { $exists: true },
        topics: { $exists: true }
      });
      
      if (sampleDoc) {
        console.log('📄 Sample document with both fields:');
        console.log(`   modules: ${JSON.stringify(sampleDoc.modules)} (${Array.isArray(sampleDoc.modules) ? 'array' : 'not array'})`);
        console.log(`   topics: ${JSON.stringify(sampleDoc.topics)} (${Array.isArray(sampleDoc.topics) ? 'array' : 'not array'})`);
        console.log('');
      }
      
      // The issue might be that mongoose schema has these fields indexed
      console.log('💡 SOLUTION: The problem is likely in your Question model schema.\n');
      console.log('Check models/question.js for these lines:\n');
      console.log('   modules: [{ type: String, index: true }]  ← Remove index: true');
      console.log('   topics: [{ type: String, index: true }]   ← Remove index: true\n');
      
    } else {
      console.log(`⚠️  Found ${problematic.length} problematic index(es):\n`);
      
      for (const idx of problematic) {
        if (idx.name === '_id_') {
          console.log(`⚠️  Skipping _id_ index (cannot drop)`);
          continue;
        }
        
        console.log(`🗑️  Dropping: ${idx.name}`);
        try {
          await collection.dropIndex(idx.name);
          console.log(`   ✅ Dropped successfully\n`);
        } catch (e) {
          console.log(`   ❌ Error: ${e.message}\n`);
        }
      }
    }
    
    console.log('\n📋 REMAINING INDEXES:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const finalIndexes = await collection.indexes();
    finalIndexes.forEach((idx, i) => {
      console.log(`${i + 1}. ${idx.name}: ${JSON.stringify(idx.key)}`);
    });
    
    console.log('\n✅ Deep index check complete!\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await mongoose.disconnect();
  }
}

deepIndexCheck()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });