// server.js — fixed
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { engine } from "express-handlebars";
import mongoose from "mongoose";
import session from "express-session";
import MongoStore from "connect-mongo";
import passport from "passport";

// middleware & admin routes
import adminRoutes from "./routes/admin.js";
import cookieParser from "cookie-parser";
import { ensureVisitorId } from "./middleware/visitorId.js";
import { visitTracker } from "./middleware/visits.js";

// utilities, passport config, auth routes
import autoFetchAndScore from "./utils/autoFetchAndScore.js";
import configurePassport from "./config/passport.js";
import authRoutes from "./routes/auth.js";
import { ensureAuth } from "./middleware/authGuard.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// parse cookies (must come before any code that reads cookies)
app.use(cookieParser());

// --------- MONGOOSE connect (optional but useful for sessions) ----------
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error("❌ MONGODB_URI missing in .env — sessions will not be persisted to MongoDB.");
} else {
  mongoose.set("strictQuery", true);
  mongoose
    .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((err) => {
      console.error("❌ MongoDB connection failed:", err.message || err);
      // continue running (sessions will fail if DB required)
    });
}

// ---------- SESSIONS (must be before passport.initialize/session) ----------
const sessionSecret = process.env.SESSION_SECRET || "change_this_secret_for_dev_only";
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: mongoUri ? MongoStore.create({ mongoUrl: mongoUri }) : undefined,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    },
  })
);

// set visitor cookie and attach req.visitorId (must be after cookieParser but CAN be before or after session)
// we place it after session to ensure req.session exists for other middleware
app.use(ensureVisitorId);

// track visits (writes Visit and UniqueVisit to MongoDB)
// put this early so visits are tracked; but it should never block request
app.use(visitTracker);

// serve static files
app.use(express.static(path.join(__dirname, "public")));

// Compatibility note: DO NOT set req.next or mutate request lifecycle helpers — that caused earlier errors.
// Handlebars setup
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure data folder exists
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath), { recursive: true });

// ---------- PASSPORT setup (after session) ----------
configurePassport(); // expects config/passport.js to call passport.use(...)
app.use(passport.initialize());
app.use(passport.session());

// expose auth routes under /auth
app.use("/auth", authRoutes);

// admin and other routes
app.use("/admin", adminRoutes);

// small debug route to inspect current user (useful for testing)
app.get("/api/whoami", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.json({ authenticated: false });
});

// --- application helpers (clean AI text, formatSCOI, public pages, etc.) ---
// Helper: clean AI text (keeps minimal whitespace normalization)
function cleanAIText(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Helper: format SCOI audit
function formatSCOI(entityData, entity) {
  const { visibility, contribution, ERF, adjustedSCOI, visibilityRationale, contributionRationale, scoiInterpretation, ERFRationale, commentary } = entityData;
  const rawSCOI = (contribution / visibility).toFixed(3);
  const adjusted = adjustedSCOI || (rawSCOI * ERF).toFixed(3);

  return `
### SCOI Audit — ${entity}

---

**1️⃣ Visibility — Score: ${visibility} / 10**  
**Rationale:**  
${visibilityRationale}

---

**2️⃣ Contribution — Score: ${contribution} / 10**  
**Rationale:**  
${contributionRationale}

---

**3️⃣ SCOI Calculation**  
SCOI = Contribution / Visibility = ${contribution} / ${visibility} = ${rawSCOI}  
**Interpretation:**  
${scoiInterpretation}

---

**4️⃣ Global Environment Adjustment — ERF: ${ERF}**  
**Rationale:**  
${ERFRationale}

---

**5️⃣ Adjusted SCOI**  
Adjusted SCOI = SCOI × ERF = ${rawSCOI} × ${ERF} = ${adjusted}

---

**6️⃣ Final CRIPFCnt Commentary:**  
${commentary}
`;
}

// Public pages
app.get("/", (req, res) => {
  // Note: ensure that views/website/index.hbs exists. If it doesn't, fallback to a plain response
  try {
    return res.render("website/index", { user: req.user || null });
  } catch (err) {
    console.error("render error for / :", err);
    return res.send("OK");
  }
});

app.get("/about", (req, res) => {
  try {
    return res.render("website/about", { user: req.user || null });
  } catch (err) {
    console.error("render error for /about :", err);
    return res.send("About page");
  }
});

app.get("/services", (req, res) => {
  try {
    return res.render("website/services", { user: req.user || null });
  } catch (err) {
    console.error("render error for /services :", err);
    return res.send("Services page");
  }
});

app.get("/contact", (req, res) => {
  try {
    return res.render("website/contact", { user: req.user || null });
  } catch (err) {
    console.error("render error for /contact :", err);
    return res.send("Contact page");
  }
});

// Protected audit route
app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
    user: req.user || null,
  });
});

// Chat stream endpoint (SSE)
app.post("/api/chat-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const keepAlive = setInterval(() => {
    try {
      res.write(":\n\n");
    } catch (e) {}
  }, 15000);

  try {
    const { entity } = req.body;
    if (!entity) {
      res.write("data: ❌ Missing entity name.\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    const systemPrompt = `You are the CRIPFCnt Audit Intelligence...`; // keep as before

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Perform a full CRIPFCnt SCOI Audit for: "${entity}".` },
      ],
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (!content) continue;
      const cleaned = cleanAIText(content);
      const lines = cleaned.split("\n");
      for (const line of lines) res.write(`data: ${line}\n`);
      res.write("\n");
    }
  } catch (err) {
    console.error("Stream error:", err);
    const msg = String(err?.message || err || "unknown error").replace(/\r?\n/g, " ");
    res.write(`data: ❌ Server error: ${msg}\n\n`);
  } finally {
    clearInterval(keepAlive);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// Simple static JSON audits route preserved
app.get("/api/audits", (req, res) => {
  res.json({ framework: "CRIPFCnt SCOI Audit System", data: [] });
});

// ---------- global error handler (last middleware) ----------
app.use((err, req, res, next) => {
  console.error("Unhandled error (global handler):", err && (err.stack || err.message || err));
  // if view 'error' exists you could render it; otherwise send simple text so nginx doesn't get 502
  try {
    // render will fail if templates are broken; fallback below
    if (res.headersSent) return next(err);
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      // attempt to render an 'error' view; if it fails we'll catch it
      return res.status(500).render("error", { error: err });
    }
  } catch (e) {
    console.error("error rendering error view:", e);
  }
  // fallback minimal response
  if (!res.headersSent) res.status(500).send("Internal Server Error");
});

// Start server
const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => console.log(`🚀 Server running on http://${HOST}:${PORT}`));
