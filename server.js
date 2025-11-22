// server.js — CRIPFCnt SCOI Server (merged, v6)
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

// ------------------ Basic parsing middleware ------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// cookies must be parsed before you try to read them in ensureVisitorId
app.use(cookieParser());

// ------------------ COMPATIBILITY SHIM (MUST BE EARLY) ------------------
// Ensure req.next exists for any code (templates, libs) that call it.
// This must run before any middleware that might later trigger rendering.
app.use((req, res, next) => {
  if (typeof req.next !== "function") req.next = next;
  next();
});

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

// ---------- SESSIONS (MUST come before passport.initialize/session) ----------
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

// ---------- PASSPORT setup (after sessions) ----------
configurePassport(); // expects config/passport.js to call passport.use(...)
app.use(passport.initialize());
app.use(passport.session());

// ---------- VISITOR ID + TRACKING (after passport & sessions) ----------
// set visitor cookie and attach req.visitorId
app.use(ensureVisitorId);
// track visits (writes Visit and UniqueVisit to MongoDB)
app.use(visitTracker);

// serve static files (after tracking so static requests are filtered/tracked too)
app.use(express.static(path.join(__dirname, "public")));

// Handlebars setup
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure data folder exists
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath), { recursive: true });

// expose auth routes under /auth and admin routes under /admin
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);

// small debug route to inspect current user (useful for testing)
app.get("/api/whoami", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.json({ authenticated: false });
});

// ... rest of your file unchanged (helpers, routes, SSE endpoint, server.start)
const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => console.log(`🚀 Server running on http://${HOST}:${PORT}`));
