// scripts/seedProfessionalQuestions.js
//
// Seeds a starter question bank for the mobile PROFESSIONALS module - eight
// short assessments, one per CRIPFCnt framework pillar. These give the pro
// courses real, on-topic content so assessments build immediately.
//
// Every question is tagged:
//   • module  = the pillar key (consciousness, responsibility, ...)
//   • modules = [pillar key]           (so the array-based query matches too)
//   • type    = "question"             (standalone MCQ, not a comprehension parent)
//   • source  = "seed-professional"    (so you can find / edit / delete these)
//
// It is IDEMPOTENT: re-running updates the same docs (upsert on source+text),
// so you can run it as many times as you like without creating duplicates.
// Edit the text in your admin afterwards - your edits are yours to keep.
//
// RUN (from your project root, same place you run the server):
//    node scripts/seedProfessionalQuestions.js
//
// It reuses the same MONGO_URI / MONGODB_URI your app uses.

import mongoose from "mongoose";
import Question from "../models/question.js";

// Best-effort: load .env the same way the server does, if dotenv is available.
try { await import("dotenv/config"); } catch { /* dotenv not installed - rely on real env */ }

const MONGO =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL ||
  "mongodb://127.0.0.1:27017/cripfcnt";

// Small deterministic PRNG (mulberry32) seeded from the question text, so the
// choice order is well-distributed but STABLE across re-runs.
function seededRng(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Helper: build a 4-choice MCQ. `answer` is the 0-based correct index in the
// ORIGINAL list. We then deterministically shuffle the options so the correct
// answer is spread across A/B/C/D rather than always landing in one spot.
const Q = (module, text, choices, answer) => {
  const rng = seededRng(text);
  const idx = choices.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const shuffled = idx.map((oi) => choices[oi]);
  const newAnswer = idx.indexOf(answer);
  return {
    module,
    modules: [module],
    type: "question",
    source: "seed-professional",
    tags: ["professional", "framework", module],
    text,
    correctIndex: newAnswer,
    choices: shuffled.map((t, i) => ({ label: "ABCD"[i], text: t }))
  };
};

const BANK = [
  // ─────────────────────────── CONSCIOUSNESS (CsQ) ───────────────────────────
  Q("consciousness", "In the CRIPFCnt framework, consciousness is best described as:",
    ["Knowing what is actually happening, not just what you are told",
     "Having strong personal opinions", "Reacting quickly to events", "Memorising procedures"], 0),
  Q("consciousness", "A report says a project is 'on track', but three deadlines slipped last month. A conscious professional first:",
    ["Accepts the report because it is official", "Checks the underlying evidence against the claim",
     "Waits for the next report", "Blames the person who wrote it"], 1),
  Q("consciousness", "The biggest threat to situational awareness in a team is usually:",
    ["Too much data", "Unexamined assumptions everyone shares", "New members asking questions", "Slow email"], 1),
  Q("consciousness", "'Seeing the system' means paying attention to:",
    ["Only your own tasks", "How parts connect and influence each other", "The loudest person in the room", "Last year's results only"], 1),
  Q("consciousness", "Which is the clearest sign you are reacting to a narrative rather than reality?",
    ["You can point to specific evidence", "You feel certain but cannot say what would change your mind",
     "You asked two independent sources", "You wrote down your assumptions"], 1),
  Q("consciousness", "A blind spot is dangerous mainly because:",
    ["It is visible to everyone else", "By definition you don't know it is there",
     "It only affects beginners", "It disappears with experience"], 1),
  Q("consciousness", "The most useful question for raising awareness of a situation is:",
    ["Whose fault is this?", "What is actually happening here, and how do I know?",
     "Who agrees with me?", "How do I look right now?"], 1),
  Q("consciousness", "Consciousness turns into an advantage when it leads to:",
    ["More meetings", "Better-informed decisions and earlier course-correction",
     "Longer reports", "Avoiding all risk"], 1),

  // ─────────────────────────── RESPONSIBILITY (RQ) ───────────────────────────
  Q("responsibility", "In the framework, responsibility is defined as owning:",
    ["Your intentions", "Outcomes, not just intentions", "Other people's mistakes", "The org chart"], 1),
  Q("responsibility", "A deliverable is late because a supplier failed. The responsible response is to:",
    ["Explain it was the supplier's fault and move on", "Own the outcome and put a recovery plan in place",
     "Wait to be asked about it", "Reduce your own future commitments quietly"], 1),
  Q("responsibility", "The difference between blame and responsibility is that responsibility focuses on:",
    ["Who is at fault", "What you will do about the outcome", "Punishment", "The past only"], 1),
  Q("responsibility", "Taking responsibility for a result you only partly control means:",
    ["Claiming total control", "Owning your contribution and influencing what you can",
     "Refusing the task", "Passing it to someone senior"], 1),
  Q("responsibility", "Which statement best reflects high responsibility?",
    ["'I meant well, so the result isn't on me'", "'The outcome is mine to improve, whatever caused it'",
     "'It's not in my job description'", "'Nobody told me'"], 1),
  Q("responsibility", "A responsible professional treats a missed target primarily as:",
    ["A reason to assign blame", "Information to act on and a commitment to recover",
     "Something to hide", "Someone else's problem"], 1),
  Q("responsibility", "Responsibility scales with:",
    ["Job title only", "The outcomes you choose to own", "How busy you look", "Years employed"], 1),
  Q("responsibility", "The clearest evidence of responsibility is:",
    ["A good excuse", "A concrete corrective action you took", "A long apology", "A meeting invite"], 1),

  // ─────────────────────────── INTERPRETATION (IQ) ───────────────────────────
  Q("interpretation", "Interpretation, in the framework, is the ability to:",
    ["Read what others miss in the same information", "Speak more loudly", "Memorise more facts", "Avoid analysis"], 0),
  Q("interpretation", "Two analysts see identical data but reach different conclusions. This is mostly explained by:",
    ["One of them cheating", "Differences in how they interpret and frame the data",
     "The data being wrong", "Random luck"], 1),
  Q("interpretation", "The first risk when interpreting information is:",
    ["Having too many sources", "Confirming what you already believe", "Reading slowly", "Taking notes"], 1),
  Q("interpretation", "Strong interpretation pairs pattern-spotting with:",
    ["Ignoring context", "Testing the pattern against evidence that could disprove it",
     "Trusting the first impression", "Avoiding numbers"], 1),
  Q("interpretation", "A leading indicator differs from a lagging one because it:",
    ["Reports the past", "Signals what is likely to happen next", "Is always more accurate", "Needs no context"], 1),
  Q("interpretation", "To interpret a surprising result well, you should first ask:",
    ["Who can I blame?", "What else would be true if this were correct?",
     "How do I make it go away?", "Who agrees with me?"], 1),
  Q("interpretation", "Context matters in interpretation because the same fact can:",
    ["Never change meaning", "Mean opposite things in different situations",
     "Only be understood by experts", "Be ignored safely"], 1),
  Q("interpretation", "Good interpretation is most valuable when it:",
    ["Sounds impressive", "Changes a decision for the better", "Delays action", "Repeats consensus"], 1),

  // ─────────────────────────────── PURPOSE (PQ) ──────────────────────────────
  Q("purpose", "Purpose, in the framework, is direction that turns:",
    ["Activity into contribution", "Effort into busyness", "Plans into meetings", "Ideas into slides"], 0),
  Q("purpose", "The difference between being busy and being purposeful is:",
    ["Purpose ties effort to a meaningful outcome", "Busy people work harder",
     "Purpose means doing less", "There is no difference"], 0),
  Q("purpose", "A useful test of whether a task serves your purpose is:",
    ["Does it fill the day?", "Does it move a goal that actually matters?",
     "Is it urgent-looking?", "Did someone else ask?"], 1),
  Q("purpose", "Purpose helps most with:",
    ["Choosing what NOT to do", "Doing everything requested", "Avoiding decisions", "Looking productive"], 0),
  Q("purpose", "When many demands compete, purpose acts as a:",
    ["Reason to do them all", "Filter for what deserves your effort", "Way to avoid work", "Source of stress only"], 1),
  Q("purpose", "A goal without purpose tends to become:",
    ["A meaningful contribution", "Activity for its own sake", "Automatically successful", "Easier to reach"], 1),
  Q("purpose", "Purpose is best expressed as:",
    ["A vague wish", "A clear direction that guides trade-offs", "A daily to-do list", "A job title"], 1),
  Q("purpose", "Contribution differs from output because contribution is measured by:",
    ["How much you produced", "The value it creates for others / the goal", "Hours worked", "Files sent"], 1),

  // ────────────────────────────── FREQUENCIES (FQ) ───────────────────────────
  Q("frequencies", "Frequencies, in the framework, is the idea that:",
    ["How you communicate decides who actually hears you", "Louder is always better",
     "Communication doesn't matter", "Only the message matters, not the audience"], 0),
  Q("frequencies", "Tuning your 'frequency' to an audience mainly means:",
    ["Changing your core message to please everyone", "Adapting how you deliver it so it lands with them",
     "Speaking faster", "Using more jargon"], 1),
  Q("frequencies", "A technically correct message can still fail because:",
    ["Facts are unimportant", "It was delivered on the wrong frequency for the audience",
     "It was too short", "It used simple words"], 1),
  Q("frequencies", "The best sign your communication worked is:",
    ["You felt clear", "The other person can act on it correctly", "You used many words", "Nobody replied"], 1),
  Q("frequencies", "Matching frequency to a skeptical executive usually means leading with:",
    ["Background detail first", "The decision, the impact, and the ask", "Technical appendices", "Small talk only"], 1),
  Q("frequencies", "Listening improves your frequency because it tells you:",
    ["Nothing useful", "What the other person values and how they take in information",
     "How to talk more", "When to interrupt"], 1),
  Q("frequencies", "Miscommunication is best treated as:",
    ["The listener's fault", "A signal to adjust how you send the message", "Unavoidable", "A reason to give up"], 1),
  Q("frequencies", "High frequency-intelligence shows up as:",
    ["Being heard by very different audiences", "Talking over people", "Always emailing", "Avoiding hard topics"], 0),

  // ────────────────────────────── CIVILIZATION (CvQ) ─────────────────────────
  Q("civilization", "Civilization, in the framework, connects:",
    ["Individual progress to collective advance", "Personal gain to nothing else",
     "Rules to punishment", "Wealth to status only"], 0),
  Q("civilization", "A civilization-minded professional evaluates a win by asking whether it:",
    ["Benefits only me", "Also strengthens the wider group / system",
     "Looks impressive", "Was fast"], 1),
  Q("civilization", "Short-term individual gains that damage the collective are risky because:",
    ["They always fail immediately", "They erode the system everyone depends on",
     "They are illegal everywhere", "They never help anyone"], 1),
  Q("civilization", "Contributing to the collective often means:",
    ["Sacrificing all self-interest", "Aligning your progress with shared advancement",
     "Ignoring your own goals", "Waiting for permission"], 1),
  Q("civilization", "A healthy team culture reflects civilization intelligence when:",
    ["Individuals hoard knowledge", "Individual growth raises the whole team's capability",
     "Only leaders benefit", "Competition is the only value"], 1),
  Q("civilization", "The long-term test of a contribution is whether it:",
    ["Made one person look good", "Left the system better than it found it",
     "Avoided all cost", "Happened quickly"], 1),
  Q("civilization", "Trust is a civilization asset because it:",
    ["Slows everything down", "Lowers the cost of cooperation across people",
     "Only matters to leaders", "Is unrelated to results"], 1),
  Q("civilization", "Individual and collective progress are best treated as:",
    ["Always opposed", "Able to reinforce each other when aligned",
     "Unrelated", "Someone else's concern"], 1),

  // ────────────────────────────── NEGOTIATION (NQ) ───────────────────────────
  Q("negotiation", "The framework's view is that every outcome is:",
    ["Fixed in advance", "Negotiated, including the silences", "Decided by luck", "Beyond your influence"], 1),
  Q("negotiation", "'Including the silences' means:",
    ["Only spoken terms count", "What is left unsaid also shapes the outcome",
     "Silence means agreement", "You should never pause"], 1),
  Q("negotiation", "The strongest position in a negotiation usually comes from:",
    ["Talking the most", "Understanding the other side's real interests and your alternatives",
     "Making the first threat", "Hiding all information"], 1),
  Q("negotiation", "A good agreement is best judged by whether it:",
    ["Crushed the other side", "Is durable and both sides will actually honour it",
     "Was signed fastest", "Made you look tough"], 1),
  Q("negotiation", "Your BATNA (best alternative to a negotiated agreement) matters because it:",
    ["Is irrelevant", "Sets the point below which you should walk away",
     "Should always be hidden forever", "Only applies to lawyers"], 1),
  Q("negotiation", "Interests differ from positions in that interests are:",
    ["What someone demands", "The underlying needs behind the demand",
     "Always the same as positions", "Never worth exploring"], 1),
  Q("negotiation", "Preparation improves negotiation mainly by:",
    ["Making you talk faster", "Clarifying your interests, theirs, and your alternatives",
     "Guaranteeing you win", "Removing all disagreement"], 1),
  Q("negotiation", "A skilled negotiator treats a hard 'no' as:",
    ["The absolute end", "Information about interests to work with", "A personal insult", "A reason to concede everything"], 1),

  // ────────────────────────────── TECHNOLOGY (TQ) ────────────────────────────
  Q("technology", "Technology intelligence, in the framework, is about understanding:",
    ["The new rules of who gets seen and trusted", "How to fix every device",
     "Coding only", "Avoiding all new tools"], 0),
  Q("technology", "In a digital environment, visibility increasingly depends on:",
    ["Job title alone", "How well you use the platforms that decide who is seen",
     "Seniority only", "Never being online"], 1),
  Q("technology", "Adopting a new tool wisely means first asking:",
    ["Is it the newest?", "What problem does it solve and at what cost/risk?",
     "Does everyone else have it?", "Is it free?"], 1),
  Q("technology", "Trust online is built mainly through:",
    ["Volume of posts", "Consistent, verifiable, valuable signals over time",
     "Following trends", "Buying attention"], 1),
  Q("technology", "The risk of ignoring technology shifts is that you:",
    ["Save time", "Become invisible or irrelevant in the new rules",
     "Automatically stay trusted", "Avoid all mistakes"], 1),
  Q("technology", "A professional with high technology intelligence treats tools as:",
    ["Magic that replaces judgment", "Leverage that amplifies clear thinking",
     "Something to fear", "Only IT's concern"], 1),
  Q("technology", "The key question about an AI tool for your work is:",
    ["Is it impressive?", "Where does it genuinely add value, and where must a human decide?",
     "Does it look modern?", "Is everyone using it?"], 1),
  Q("technology", "Being 'seen and trusted' in a digital world is increasingly:",
    ["Automatic with age", "An earned outcome of how you show up and deliver online",
     "Impossible", "Unrelated to skill"], 1)
];

async function run() {
  console.log(`[seed-pro] connecting to Mongo...`);
  await mongoose.connect(MONGO);
  console.log(`[seed-pro] connected. Seeding ${BANK.length} questions...`);

  let upserts = 0;
  for (const q of BANK) {
    await Question.updateOne(
      { source: "seed-professional", text: q.text }, // stable key → idempotent
      { $set: { ...q, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    upserts++;
  }

  // Report per-pillar counts of answerable questions (what the app will see).
  const PILLARS = ["consciousness","responsibility","interpretation","purpose","frequencies","civilization","negotiation","technology"];
  console.log(`[seed-pro] done. Answerable questions per pillar:`);
  for (const m of PILLARS) {
    const n = await Question.countDocuments({
      $and: [
        { $or: [{ module: m }, { modules: m }] },
        { type: { $ne: "comprehension" } },
        { correctIndex: { $ne: null } },
        { "choices.1": { $exists: true } }
      ]
    });
    console.log(`   ${m.padEnd(16)} ${n}`);
  }

  await mongoose.disconnect();
  console.log(`[seed-pro] upserted ${upserts} questions. Disconnected.`);
  process.exit(0);
}

run().catch((err) => {
  console.error("[seed-pro] FAILED:", err);
  process.exit(1);
});