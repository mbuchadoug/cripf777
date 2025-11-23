// server.js — CRIPFCnt SCOI Server (merged, v6) — UPDATED (safe render wrapper)
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

import autoFetchAndScore from "./utils/autoFetchAndScore.js";
import configurePassport from "./config/passport.js";
import { ensureAuth } from "./middleware/authGuard.js";
import { ensureVisitorId } from "./middleware/visitorId.js";
import { visitTracker } from "./middleware/visits.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// -------------------- Basic middleware --------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
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
    });
}

// ---------- SESSIONS ----------
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
      sameSite: "lax",
    },
  })
);

// visitor id + tracker (after session & cookie)
app.use(ensureVisitorId);
app.use(visitTracker);

// -------------------- SAFETY PATCH: ensure req.next/res.next and a safer res.render --------------------
app.use((req, res, next) => {
  // ensure req.next exists and is callable
  if (typeof req.next !== "function") {
    Object.defineProperty(req, "next", {
      value: (...args) => {
        try {
          return next(...args);
        } catch (err) {
          console.error("req.next wrapper error:", err);
        }
      },
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }

  if (typeof res.next !== "function") {
    Object.defineProperty(res, "next", {
      value: (...args) => {
        try {
          return next(...args);
        } catch (err) {
          console.error("res.next wrapper error:", err);
        }
      },
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }

  next();
});

// IIFE that patches res.render to be safer
(() => {
  const originalRender = app.response.render;
  app.response.render = function (view, options, cb) {
    const res = this;
    const req = res.req;

    // normalize args (view, [options], [cb])
    if (typeof options === "function") {
      cb = options;
      options = undefined;
    }

    const safeCallback = (err, html) => {
      if (err) {
        // log useful debug info about which view and locals caused the error
        try {
          const localsSummary = options ? (typeof options === "object" ? Object.keys(options) : String(options)) : "(no locals)";
          console.error(`Render ERROR for view="${view}" locals=${localsSummary}:`, err && (err.stack || err));
        } catch (logErr) {
          console.error("Failed to log render error context:", logErr);
        }
        // forward to next (use req.next if available)
        const forward = typeof (req && req.next) === "function" ? req.next : (e) => console.error("No next to forward render error:", e);
        try {
          return forward(err);
        } catch (fwdErr) {
          console.error("Error forwarding render error:", fwdErr);
          // last resort: ensure we don't crash and try to send a fallback 500 if possible
          if (!res.headersSent) {
            try { res.status(500).send("Server error during render"); } catch (sErr) { console.error("Failed fallback send:", sErr); }
          }
          return;
        }
      }

      // If callback was provided by caller, call it first (it might handle sending)
      if (typeof cb === "function") {
        try {
          cb(null, html);
        } catch (cbErr) {
          console.error("Callback threw while handling rendered HTML:", cbErr);
        }
      }

      // Only send if nothing else has sent response yet
      if (!res.headersSent) {
        try {
          res.send(html);
        } catch (sendErr) {
          console.error("Failed to send rendered html (headers may have been sent):", sendErr);
        }
      } else {
        // headers already sent — nothing to do
      }
    };

    // Call original render which will eventually invoke our callback
    try {
      return originalRender.call(res, view, options, safeCallback);
    } catch (e) {
      // if render throws synchronously, forward to next
      console.error("Synchronous render exception for view=", view, e && (e.stack || e));
      const forward = typeof (req && req.next) === "function" ? req.next : (err) => console.error("No next to forward render exception:", err);
      try {
        return forward(e);
      } catch (fwdErr) {
        console.error("Failed forwarding sync render exception:", fwdErr);
        if (!res.headersSent) {
          try { res.status(500).send("Server render exception"); } catch (sErr) { console.error("Failed fallback send:", sErr); }
        }
      }
    }
  };
})();

// Handlebars setup (view engine)
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure data folder exists
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath), { recursive: true });

// ---------- PASSPORT setup ----------
configurePassport();
app.use(passport.initialize());
app.use(passport.session());

app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);

// small debug route
app.get("/api/whoami", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.json({ authenticated: false });
});

// Helper and routes (unchanged — include your SSE route and others here)
function cleanAIText(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

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

app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
    user: req.user || null,
  });
});

app.post("/api/chat-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const keepAlive = setInterval(() => {
    try { res.write(":\n\n"); } catch (e) {}
  }, 15000);

  try {
    const { entity } = req.body;
    if (!entity) {
      res.write("data: ❌ Missing entity name.\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    const systemPrompt = `
You are the CRIPFCnt Audit Intelligence — trained under Donald Mataranyika’s civilization recalibration model.
Generate a single, clean, structured SCOI audit for the entity provided.
Follow this structure exactly:

1️⃣ Visibility — score and rationale
2️⃣ Contribution — score and rationale
3️⃣ SCOI = Contribution / Visibility (with brief interpretation)
4️⃣ Global Environment Adjustment — assign ERF (Environmental Resilience Factor)
5️⃣ Adjusted SCOI = SCOI × ERF
6️⃣ Final CRIPFCnt Commentary

Return the audit as readable text.
`;

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Perform a full CRIPFCnt SCOI Audit for: "${entity}". Include all scores, adjusted SCOI, and interpretive commentary.` },
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

// sample audits route (unchanged)
app.get("/api/audits", (req, res) => {
  res.json({ framework: "CRIPFCnt SCOI Audit System", author: "Donald Mataranyika", data: [] });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR HANDLER:", err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).send("Internal server error (see server logs).");
});

// SERVER START
const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => console.log(`🚀 Server running on http://${HOST}:${PORT}`));
