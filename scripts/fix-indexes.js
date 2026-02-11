// scripts/fix-indexes.js
// Drop conflicting indexes and recreate them properly

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

async function fixIndexes() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');
    
    const db = mongoose.connection.db;
    const collection = db.collection('questions');
    
    // Get current indexes
    console.log('📋 Current indexes:');
    const indexes = await collection.indexes();
    indexes.forEach(idx => {
      console.log(`   - ${idx.name}: ${JSON.stringify(idx.key)}`);
    });
    console.log('');
    
    // Find problematic indexes
    const problematicIndexes = indexes.filter(idx => {
      const keys = Object.keys(idx.key);
      const hasMultipleArrays = 
        (keys.includes('modules') || keys.includes('topics')) &&
        keys.length > 1 &&
        (keys.includes('modules') && keys.includes('topics'));
      
      return hasMultipleArrays;
    });
    
    if (problematicIndexes.length > 0) {
      console.log('⚠️  Found problematic indexes:');
      problematicIndexes.forEach(idx => {
        console.log(`   - ${idx.name}`);
      });
      console.log('');
      
      // Drop them
      for (const idx of problematicIndexes) {
        if (idx.name !== '_id_') { // never drop the _id index
          console.log(`🗑️  Dropping index: ${idx.name}`);
          await collection.dropIndex(idx.name);
        }
      }
      console.log('');
    }
    
    // Drop any indexes that contain both modules and topics
    console.log('🔍 Checking for indexes with both modules and topics...\n');
    
    for (const idx of indexes) {
      const keys = Object.keys(idx.key);
      if (keys.includes('modules') && keys.includes('topics') && idx.name !== '_id_') {
        console.log(`🗑️  Dropping: ${idx.name}`);
        try {
          await collection.dropIndex(idx.name);
        } catch (e) {
          console.log(`   ⚠️  Could not drop ${idx.name}: ${e.message}`);
        }
      }
    }
    
    console.log('\n✅ Creating new indexes...\n');
    
    // Create new single-field indexes
    const newIndexes = [
      { modules: 1 },
      { topics: 1 },
      { organization: 1 },
      { organization: 1, modules: 1 },
      { organization: 1, topics: 1 },
      { organization: 1, series: 1 },
      { subject: 1, topic: 1, difficulty: 1, grade: 1 }, // for adaptive learning
      { subject: 1, grade: 1, topic: 1 }
    ];
    
    for (const indexSpec of newIndexes) {
      try {
        await collection.createIndex(indexSpec);
        console.log(`✅ Created index: ${JSON.stringify(indexSpec)}`);
      } catch (e) {
        if (e.code === 85 || e.codeName === 'IndexOptionsConflict') {
          console.log(`⚠️  Index already exists: ${JSON.stringify(indexSpec)}`);
        } else {
          console.log(`❌ Failed to create ${JSON.stringify(indexSpec)}: ${e.message}`);
        }
      }
    }
    
    console.log('\n📋 Final indexes:');
    const finalIndexes = await collection.indexes();
    finalIndexes.forEach(idx => {
      console.log(`   - ${idx.name}: ${JSON.stringify(idx.key)}`);
    });
    
    console.log('\n✅ Index fix complete!\n');
    console.log('You can now run: node scripts/categorize-cripfcnt-questions.js\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await mongoose.disconnect();
  }
}

fixIndexes()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });