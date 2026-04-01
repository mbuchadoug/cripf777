// Run: node debug-search.js
// Tells you exactly why "dentist" returns 0 results
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const col = db.collection('supplierprofiles');

// Step 1: Is the supplier there at all?
const total = await col.countDocuments({ businessName: /vitality dental/i });
console.log('Vitality Dental docs:', total);

const doc = await col.findOne({ businessName: /vitality dental/i });
if (doc) {
  console.log('active:', doc.active);
  console.log('subscriptionStatus:', doc.subscriptionStatus);
  console.log('suspended:', doc.suspended);
  console.log('products:', doc.products);
  console.log('listedProducts:', doc.listedProducts);
  console.log('rates:', doc.rates);
  console.log('categories:', doc.categories);
  console.log('location:', doc.location);
}

// Step 2: Does the full query find it?
const results = await col.find({
  active: true,
  $and: [
    { $or: [{ suspended: false }, { suspended: { $exists: false } }] },
    { subscriptionStatus: "active" },
    { $or: [
      { products: { $regex: "dentist", $options: "i" } },
      { products: { $regex: "teeth cleaning", $options: "i" } },
      { products: { $regex: "check-ups", $options: "i" } },
      { categories: { $regex: "medical_health", $options: "i" } },
      { businessName: { $regex: "dentist", $options: "i" } },
    ]}
  ]
}).toArray();
console.log('\nFull query results:', results.length);
if (results.length) console.log('Found:', results.map(r => r.businessName));

await mongoose.disconnect();