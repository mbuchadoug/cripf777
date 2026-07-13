// migrate_lang_en.js — one-time migration.
// Stamps every pre-partition question and quiz (those with no `lang` field)
// as English. Safe to run more than once; only touches docs missing `lang`.
//
//   node migrate_lang_en.js
//
// The route code already treats "missing lang" as English defensively, so the
// app works even without this. But running it makes the admin panel's language
// filters (which query lang:"en" exactly) show your existing English content,
// and keeps the data clean.
import mongoose from "mongoose";
import EightQTQuestion from "./models/eightQTQuestion.js";
import EightQTQuiz from "./models/eightQTQuiz.js";

const MONGO = process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/YOUR_DB";

await mongoose.connect(MONGO);
console.log("Connected.\n");

const missing = { $or: [{ lang: { $exists: false } }, { lang: null }] };

const qBefore = await EightQTQuestion.countDocuments(missing);
const qRes = await EightQTQuestion.updateMany(missing, { $set: { lang: "en" } });
console.log(`Questions without lang: ${qBefore} → set to "en": ${qRes.modifiedCount}`);

const zBefore = await EightQTQuiz.countDocuments(missing);
const zRes = await EightQTQuiz.updateMany(missing, { $set: { lang: "en" } });
console.log(`Quizzes without lang:   ${zBefore} → set to "en": ${zRes.modifiedCount}`);

// Report the resulting split so you can eyeball it
const qEn = await EightQTQuestion.countDocuments({ lang: "en" });
const qSn = await EightQTQuestion.countDocuments({ lang: "sn" });
console.log(`\nQuestion bank now: en=${qEn}  sn=${qSn}`);

await mongoose.disconnect();
console.log("Done.");