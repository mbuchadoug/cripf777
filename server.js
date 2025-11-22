// server.js — CLEAN FIXED VERSION
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
import cookieParser from "cookie-parser";

import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import { ensureVisitorId } from "./middleware/visitorId.js";
import { visitTracker } from "./middleware/visits.js";
import configurePassport from "./config/passport.js";
import { ensureAuth } from "./middleware/authGuard.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ----------------------------------------------------
// BASIC MIDDLEWARE
// ----------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// IMPORTANT: assign visitor ID BEFORE visit tracker
app.use(ensureVisitorId);

// Visit tracker must run early but must NEVER crash server
app.use((req, res, next) => {
  try {
    visitTracker(req, res, next);
  } catch (e) {
    console.error("[visitTracker fatal]", e);
    next(); // continue safely
  }
});

// ----------------------------------------------------
// STATIC FILES
// ----------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ----------------------------------------------------
// HANDLEBARS ENGINE
// ----------------------------------------------------
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// ----------------------------------------------------
// MONGO CONNECTION
// ----------------------------------------------------
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error("❌ No MONGODB_URI in .env");
} else {
  mongoose
    .connect(mongoUri)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB error:", err));
}

// ----------------------------------------------------
// SESSION (MUST be BEFORE passport.session())
// ----------------------------------------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret",
    resave: false,
    saveUninitialized: false,
    store: mongoUri ? MongoStore.create({ mongoUrl: mongoUri }) : undefined,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30,
      httpOnly: true,
      secure: false,
    },
  })
);

// ----------------------------------------------------
// PASSPORT
// ----------------------------------------------------
configurePassport();
app.use(passport.initialize());
app.use(passport.session());

// ----------------------------------------------------
// ROUTES
// ----------------------------------------------------
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);

// Public pages
app.get("/", (req, res) => {
  res.render("website/index", { user: req.user || null });
});

app.get("/about", (req, res) => {
  res.render("website/about", { user: req.user || null });
});

app.get("/services", (req, res) => {
  res.render("website/services", { user: req.user || null });
});

app.get("/contact", (req, res) => {
  res.render("website/contact", { user: req.user || null });
});

// ----------------------------------------------------
// PROTECTED CHAT ROUTE
// ----------------------------------------------------
app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name.",
    user: req.user || null,
  });
});

// ----------------------------------------------------
// SSE CHAT STREAM
// ----------------------------------------------------
app.post("/api/chat-stream", async (req, res) => {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const { entity } = req.body;
    if (!entity) {
      res.write("data: Missing entity\n\n");
      return res.end();
    }

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: "Perform SCOI audit." },
        { role: "user", content: entity },
      ],
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) res.write(`data: ${content}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("chat-stream error:", err);
    try {
      res.write(`data: ERROR: ${err.message}\n\n`);
      res.end();
    } catch {}
  }
});

// ----------------------------------------------------
// GLOBAL ERROR HANDLER — avoids Express crash
// ----------------------------------------------------
app.use((err, req, res, next) => {
  console.error("🔥 GLOBAL ERROR:", err);
  res.status(500).send("Internal Server Error");
});

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------
const PORT = process.env.PORT || 9000;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`🚀 Server running on http://127.0.0.1:${PORT}`);
});
