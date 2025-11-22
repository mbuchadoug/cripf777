// server.js — CRIPFCnt SCOI Server (stable clean version)

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

// middleware
import { ensureVisitorId } from "./middleware/visitorId.js";
import { visitTracker } from "./middleware/visits.js";

// routes
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";

// utils
import configurePassport from "./config/passport.js";
import { ensureAuth } from "./middleware/authGuard.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------------------- Basic middleware ----------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Visitor ID + tracking
app.use(ensureVisitorId);
app.use(visitTracker);

// Static files
app.use(express.static(path.join(__dirname, "public")));

// ---------------------- Handlebars ----------------------
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// ---------------------- MongoDB ----------------------
const mongoUri = process.env.MONGODB_URI;

mongoose.set("strictQuery", true);

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log("✅ Connected to MongoDB");
}).catch(err => {
  console.error("❌ MongoDB connection error:", err.message);
});

// ---------------------- Sessions ----------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change_me",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: mongoUri }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30,
      httpOnly: true,
      secure: false
    }
  })
);

// ---------------------- Passport ----------------------
configurePassport();
app.use(passport.initialize());
app.use(passport.session());

// ---------------------- Routes ----------------------
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);

app.get("/", (req, res) => {
  res.render("website/index", { user: req.user || null });
});

app.get("/about", (req, res) => res.render("website/about"));
app.get("/services", (req, res) => res.render("website/services"));
app.get("/contact", (req, res) => res.render("website/contact"));

// Protected chat route
app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    user: req.user
  });
});

// ---------------------- SSE AI Stream ----------------------
app.post("/api/chat-stream", async (req, res) => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const { entity } = req.body;

  if (!entity) {
    res.write("data: Missing entity\n\n");
    return res.end();
  }

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: "Perform CRIPFCnt SCOI audit." },
        { role: "user", content: `Audit "${entity}"` }
      ]
    });

    for await (const chunk of stream) {
      const text = chunk?.choices?.[0]?.delta?.content;
      if (text) res.write(`data: ${text}\n\n`);
    }
  } catch (err) {
    res.write(`data: ERROR: ${err.message}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

// ---------------------- Start Server ----------------------
const PORT = process.env.PORT || 9000;
app.listen(PORT, "127.0.0.1", () =>
  console.log(`🚀 Server running at http://127.0.0.1:${PORT}`)
);
