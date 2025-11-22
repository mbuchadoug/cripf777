// server.js — fixed, ordered, robust

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

// middleware & routes
import { ensureVisitorId } from "./middleware/visitorId.js";
import { visitTracker } from "./middleware/visits.js";
import configurePassport from "./config/passport.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import { ensureAuth } from "./middleware/authGuard.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------- basic middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // parse cookies before sessions (optional but fine)

// ---------- visitor cookie + tracking (these do not depend on session) ----------
app.use(ensureVisitorId);
app.use(visitTracker);

// ---------- static files ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Handlebars setup ----------
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// ---------- ensure data folder exists ----------
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath), { recursive: true });

// ---------- MongoDB connection (with sensible fallback) ----------
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/cripfcnt";
mongoose.set("strictQuery", true);
mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB connection failed:", err.message || err));

// ---------- sessions (MUST come before passport.session() and before auth routes) ----------
const sessionSecret = process.env.SESSION_SECRET || "change_this_secret_for_prod";
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: mongoUri }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax"
  }
}));

// ---------- passport (configure BEFORE initialize to ensure strategies loaded) ----------
configurePassport();        // registers passport strategies
app.use(passport.initialize());
app.use(passport.session());

// ---------- mount routes (after sessions & passport) ----------
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);

// small debug endpoint
app.get("/api/whoami", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.json({ authenticated: false });
});

// ---------- website routes ----------
app.get("/", (req, res) => res.render("website/index", { user: req.user || null }));
app.get("/about", (req, res) => res.render("website/about", { user: req.user || null }));
app.get("/services", (req, res) => res.render("website/services", { user: req.user || null }));
app.get("/contact", (req, res) => res.render("website/contact", { user: req.user || null }));

app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
    user: req.user || null
  });
});

// ---------- example SSE chat endpoint (keeps minimal changes) ----------
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

app.post("/api/chat-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const keepAlive = setInterval(() => { try { res.write(":\n\n"); } catch {} }, 15000);

  try {
    const entity = req.body?.entity;
    if (!entity) {
      res.write("data: ❌ Missing entity name\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    // NOTE: replace with your actual OpenAI stream logic if required.
    // This is a small safe placeholder showing the SSE pattern.
    res.write(`data: Starting audit for "${entity}"\n\n`);
    res.write("data: [DONE]\n\n");
  } catch (err) {
    console.error("chat-stream error:", err);
    res.write(`data: ERROR ${String(err.message || err)}\n\n`);
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

// ---------- global error handler (prevents unhandled crashes) ----------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err && (err.stack || err.message || err));
  // if response already started, just end
  if (res.headersSent) return req.next && req.next(err);
  // render friendly page for HTML, else JSON
  if (req.headers.accept && req.headers.accept.includes("text/html")) {
    try {
      return res.status(500).render("error", { message: "Server error" });
    } catch (e) {
      return res.status(500).send("Server error");
    }
  }
  return res.status(500).json({ error: "Server error" });
});

// ---------- start ----------
const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => console.log(`🚀 Server running on http://${HOST}:${PORT}`));
