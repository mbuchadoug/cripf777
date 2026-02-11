// verify-setup.js - FIXED to use .env
import mongoose from "mongoose";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

async function verify() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    
    if (!mongoUri) {
      console.log('❌ No MONGO_URI or MONGODB_URI found in environment!');
      console.log('   Make sure .env file exists with MONGO_URI set\n');
      return;
    }
    
    console.log('🔌 Connecting to MongoDB...');
    console.log(`   URI: ${mongoUri.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@')}\n`);
    
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');
    
    // Check org
    const org = await mongoose.connection.db.collection('organizations').findOne({
      slug: 'cripfcnt-school'
    });
    
    if (!org) {
      console.log('❌ Organization "cripfcnt-school" not found!\n');
      
      // Show what orgs exist
      const allOrgs = await mongoose.connection.db.collection('organizations').find({}).toArray();
      console.log(`📊 Found ${allOrgs.length} organization(s):`);
      allOrgs.forEach((o, i) => {
        console.log(`   ${i + 1}. "${o.name}" (slug: "${o.slug}")`);
      });
      console.log('');
      return;
    }
    
    console.log('✅ Organization found:');
    console.log(`   Name: ${org.name}`);
    console.log(`   Slug: ${org.slug}`);
    console.log(`   ID: ${org._id}\n`);
    
    // Check questions
    const totalQ = await mongoose.connection.db.collection('questions').countDocuments({
      organization: org._id,
      type: { $ne: 'comprehension' }
    });
    
    console.log(`📊 Questions to categorize: ${totalQ}`);
    
    if (totalQ === 0) {
      console.log('⚠️  No questions found for this organization!\n');
      
      // Check if questions exist without type filter
      const withComprehension = await mongoose.connection.db.collection('questions').countDocuments({
        organization: org._id
      });
      console.log(`📊 Total questions (including comprehension): ${withComprehension}\n`);
    } else {
      console.log('✅ Ready to categorize!\n');
      
      // Sample a question
      const sample = await mongoose.connection.db.collection('questions').findOne({
        organization: org._id,
        type: { $ne: 'comprehension' }
      });
      
      if (sample) {
        console.log('📝 Sample question:');
        console.log(`   Text: "${sample.text.substring(0, 80)}..."`);
        console.log(`   Current module: ${sample.module || 'not set'}`);
        console.log(`   Has modules array: ${sample.modules ? 'yes' : 'no'}`);
        console.log(`   Has topics array: ${sample.topics ? 'yes' : 'no'}\n`);
      }
    }
    
    console.log('✅ Setup verification complete!');
    console.log('   Run: node scripts/categorize-cripfcnt-questions.js\n');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

verify();