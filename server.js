// server.js — CRIPFCnt SCOI Server (merged, updated)
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
import Handlebars from "handlebars";
import consumerRoutes from "./routes/consumer.js";
import consumerQuizRoutes from "./routes/consumer_quiz.js";
import adminQuizRules from "./routes/admin_quiz_rules.js";
import adminExamRoutes from "./routes/admin_exams.js";

import parentRoutes from "./routes/parent.js";
import parentAttemptsRoutes from "./routes/parent_attempts.js";





import {
  allowInsecurePrototypeAccess
} from "@handlebars/allow-prototype-access";
import specialScoiImportRoutes from "./routes/admin_special_scoi_import.js";



// routes & utils
import lmsLoginRoutes from "./routes/lms_login.js";
import portalRoutes from "./routes/portal.js";
import scoiDownloadRoutes from "./routes/scoi_download.js";
import AuditPurchase from "./models/auditPurchase.js";
import PlacementAudit from "./models/placementAudit.js";



import lmsImportRoutes from "./routes/lms_Import.js";
import adminCertificateRoutes from "./routes/admin_certificates.js";

import stripeWebhookRoutes from "./routes/stripe_webhook.js";
import billingRoutes from "./routes/billing.js";

import adminPlacementImport from "./routes/admin_placement_import.js";


import scoiMarketplaceRoutes from "./routes/scoi_marketplace.js";

import scoiCheckoutRoutes from "./routes/scoi_checkout.js";

import paymentsRouter from "./routes/payments.js";












import trackRouter from "./routes/track.js";
import lmsRoutes from "./routes/lms.js";
// use the lms_api file that contains examInstance + attempt persistence
import lmsApiRoutes from "./routes/lms_api.js";
import adminRoutes from "./routes/admin.js"; // merged admin (includes import/upload UI)
import User from "./models/user.js";
import adminAttempts from "./routes/admin_attempts.js";
// org-specific quiz API (if present)
import apiOrgQuizRoutes from "./routes/api_org_quiz.js";

import configurePassport from "./config/passport.js";
import authRoutes from "./routes/auth.js";
import placementAuditRoutes from "./routes/admin_placement_audits.js";
import adminOrganizationRoutes from "./routes/admin_organizations.js";
import orgManagementRoutes from "./routes/org_management.js";
import { ensureAuth } from "./middleware/authGuard.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// friendly support contact (configurable via .env)
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@cripfcnt.com";

// ⚠️ STRIPE WEBHOOK — MUST COME FIRST


// Normal parsers for everything else
/*app.use(express.json());
app.use(express.urlencoded({ extended: true }));*/

// 1️⃣ Stripe webhook FIRST (raw body)
app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use("/stripe/webhook", stripeWebhookRoutes);




// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Compatibility shim: ensure res.render callbacks that call req.next won't crash
app.use((req, res, next) => {
  if (typeof req.next !== "function") req.next = next;
  next();
});


function renderPage(res, view, req, canonicalPath, extra = {}) {
  res.render(view, {
    siteUrl: process.env.SITE_URL ,
    canonicalPath,
    isHome: canonicalPath === "/",
    user: req.user || null,
    ...extra,
  });
}


const hbsHelpers = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  lt: (a, b) => a < b,
  gt: (a, b) => a > b,
  lte: (a, b) => a <= b,
  gte: (a, b) => a >= b,
  and: (a, b) => a && b,
  or: (a, b) => a || b,
  not: (v) => !v,
  isNull: (v) => v === null || v === undefined,
  isNumber: (v) => typeof v === "number",
subtract: (a, b) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return x - y;
},

  letters: (i) => {
    if (typeof i !== "number" || i < 0) return "";
    const seq = "abcdefghijklmnopqrstuvwxyz";
    return seq.charAt(i) || String.fromCharCode(97 + i);
  },

  inc: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? (n + 1) : v;
  },

  divide: (a, b) => {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
    return (x / y).toFixed(3);
  },

  formatDate: (date) => {
  if (!date) return "-";

  return new Date(date).toLocaleString("en-ZW", {
    timeZone: "Africa/Harare",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
},

  let: function (varNameOrOptions, maybeOptions) {
    let varName = null;
    let options = maybeOptions;
    if (typeof varNameOrOptions === "string") {
      varName = varNameOrOptions;
    } else {
      options = varNameOrOptions;
    }
    options = options || {};
    const value = options.hash ? options.hash.value : undefined;

    const ctx = Object.assign({}, this);
    if (varName) ctx[varName] = value;

    return options.fn ? options.fn(ctx) : "";
  }

  
};

/*app.engine(
  "hbs",
  engine({
    extname: ".hbs",
    defaultLayout: "main",
    helpers: hbsHelpers,
  })
);*/

app.engine(
  "hbs",
  engine({
    extname: ".hbs",
    defaultLayout: "main",
    handlebars: allowInsecurePrototypeAccess(Handlebars),
    helpers: hbsHelpers,
  })
);

app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// OpenAI client (optional)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure data folder exists
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
}

// --------- MONGOOSE connect ----------
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error("❌ MONGODB_URI missing in .env - sessions will not be persisted to MongoDB.");
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
    },
  })
);

// ---------- PASSPORT setup ----------
configurePassport(); // config/passport.js should set up strategies + serialize/deserialize
app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
  if (process.env.NODE_ENV === "production") {
    const host = req.headers.host;
    if (host !== "cripfcnt.com") {
      return res.redirect(301, "https://cripfcnt.com" + req.originalUrl);
    }
    if (req.protocol !== "https") {
      return res.redirect(301, "https://cripfcnt.com" + req.originalUrl);
    }
  }
  next();
});

// mount auth routes first (so /auth is available when needed)
app.use("/auth", authRoutes);

// ADMIN (single mount for admin UI & import routes)
app.use("/admin", adminRoutes);

// API routes — keep LMS API on /api/lms so quiz UI fetches work
app.use("/api/lms", lmsApiRoutes);

// Admin attempts UI
app.use("/", adminAttempts);

// Other API-level routes (tracking, etc.)
app.use("/api", trackRouter);

// Public LMS pages
app.use("/lms", lmsRoutes);
app.use("/admin", lmsImportRoutes);
app.use("/consumer", consumerRoutes);
app.use("/consumer", consumerQuizRoutes);


app.use("/admin", adminExamRoutes);


app.use(adminQuizRules);
app.use(parentRoutes);
app.use(adminCertificateRoutes);

//app.use(lmsLoginRoutes);
app.use(portalRoutes);
// Org-related routes
app.use(adminOrganizationRoutes);
app.use(orgManagementRoutes);
// ⚠️ must be before express.json()
//app.use("/stripe/webhook", stripeWebhookRoutes);
app.use("/billing", billingRoutes);
app.use("/payments", paymentsRouter);

app.use("/api/org", apiOrgQuizRoutes);
app.use("/", parentAttemptsRoutes);

app.use(scoiMarketplaceRoutes);

app.use(scoiCheckoutRoutes);

app.use(adminPlacementImport);

app.use(placementAuditRoutes);
app.use(scoiDownloadRoutes);
app.use(specialScoiImportRoutes);


// small debug route to inspect current user (useful for testing)
app.get("/api/whoami", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.json({ authenticated: false });
});

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
  const {
    visibility,
    contribution,
    ERF,
    adjustedSCOI,
    visibilityRationale,
    contributionRationale,
    scoiInterpretation,
    ERFRationale,
    commentary,
  } = entityData;
  const rawSCOI = (contribution / visibility).toFixed(3);
  const adjusted = adjustedSCOI || (rawSCOI * ERF).toFixed(3);

  return `
### SCOI Audit - ${entity}

---

**1️⃣ Visibility - Score: ${visibility} / 10**  
**Rationale:**  
${visibilityRationale}

---

**2️⃣ Contribution - Score: ${contribution} / 10**  
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
  renderPage(res, "website/index", req, "/");
});

app.get("/about", (req, res) => {
  renderPage(res, "website/about", req, "/about");
});

app.get("/services", (req, res) => {
  renderPage(res, "website/services", req, "/services");
});

app.get("/contact", (req, res) => {
  renderPage(res, "website/contact", req, "/contact");
});


app.get("/scoi/purchased", ensureAuth, async (req, res) => {
  const purchases = await AuditPurchase.find({
    userId: req.user._id
  })
    .populate("auditId")
    .lean();

  res.render("scoi/purchased", {
    user: req.user,
    purchases
  });
});


// -------------------------------
// 🔹 ROUTE: Render Chat Page (protected)
// -------------------------------
app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
    user: req.user || null,
  });
});


// -------------------------------
// START PAGE (Parents / Consumers)
// -------------------------------
app.get("/start", (req, res) => {
  res.render("consumer/start", {
    user: req.user || null
  });
});

// -------------------------------
// 🔹 ROUTE: Chat Stream Endpoint (SSE streaming) with daily search credits
// -------------------------------
app.post("/api/chat-stream", async (req, res) => {
  // Require authentication
  if (!(req.isAuthenticated && req.isAuthenticated())) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const user = req.user;
  const userId = user && user._id;
  const userEmail = ((user && (user.email || "")) || "").toLowerCase();

  // Admin bypass set
  const adminSet = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => String(s || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const isAdmin = userEmail && adminSet.has(userEmail);

  const DAILY_LIMIT = parseInt(process.env.SEARCH_DAILY_LIMIT || "3", 10);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let keepAlive;

  try {
    // enforce daily limit for non-admins
// 🔐 CREDIT ENFORCEMENT (HARD GATE)
if (!isAdmin) {
  const current = await User.findById(userId);

  // ❌ No credits left → STOP before OpenAI
  if (!current || current.auditCredits <= 0) {
    return res.status(402).json({
      error: "Payment required",
      message: "You’ve used your available audit credit.",
      checkoutUrl: "/billing",
      paywall: true
    });
  }

  // ✅ Consume exactly ONE credit
  current.auditCredits -= 1;
  current.lastLogin = new Date();
  await current.save();
}



    // Setup SSE headers & keep-alive after credit has been consumed
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    keepAlive = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch (e) {}
    }, 15000);

    const { entity } = req.body || {};
    if (!entity) {
      res.write("data: ❌ Missing entity name.\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    const systemPrompt = `
You are the CRIPFCnt Audit Intelligence - trained under Donald Mataranyika’s civilization recalibration model.
Generate a single, clean, structured SCOI audit for the entity provided.
Follow this structure exactly:

1️⃣ Visibility - score and rationale
2️⃣ Contribution - score and rationale
3️⃣ SCOI = Contribution / Visibility (with brief interpretation)
4️⃣ Global Environment Adjustment - assign ERF (Environmental Resilience Factor)
5️⃣ Adjusted SCOI = SCOI × ERF
6️⃣ Final CRIPFCnt Commentary

Return the audit as readable text.
`;

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Perform a full CRIPFCnt SCOI Audit for: "${entity}". Include all scores, adjusted SCOI, and interpretive commentary.`,
        },
      ],
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (!content) continue;

      const cleaned = cleanAIText(content);
      const lines = cleaned.split("\n");
      for (const line of lines) {
        res.write(`data: ${line}\n`);
      }
      res.write("\n");
    }

    clearInterval(keepAlive);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Stream / credits handler error:", err && (err.stack || err));
    try {
      if (keepAlive) clearInterval(keepAlive);
    } catch (e) {}

    const msg = String(err?.message || err || "unknown error").replace(/\r?\n/g, " ");
    if (!res.headersSent) {
      return res.status(500).json({ error: "Server error", detail: msg });
    } else {
      try {
        res.write(`data: ❌ Server error: ${msg}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
        console.error("Failed to send SSE error:", e);
      }
    }
  }
});

// -------------------------------
// 🔹 ROUTE: Static SCOI Audits (JSON)
// -------------------------------
const scoiAudits = [
  {
    organization: "Econet Holdings",
    visibility: 9.5,
    contribution: 7.0,
    rawSCOI: 0.74,
    resilienceFactor: 1.25,
    adjustedSCOI: 0.93,
    placementLevel: "Re-emerging Placement",
    interpretation: `Econet’s contribution remains high but has been visually overpowered by scale and routine visibility...`,
  },
];

app.get("/api/audits", (req, res) => {
  res.json({
    framework: "CRIPFCnt SCOI Audit System",
    author: "Donald Mataranyika",
    description:
      "Civilization-level audit system measuring organizational Visibility, Contribution, and Placement under global volatility.",
    formula: "Adjusted SCOI = Raw SCOI × Environmental Resilience Factor (ERF)",
    data: scoiAudits,
  });
});

app.get("/api/search-quota", (req, res) => {
  if (!(req.isAuthenticated && req.isAuthenticated()))
    return res.json({ authenticated: false, isAdmin: false, remaining: 0, limit: 0 });

  const user = req.user;
  const isAdmin = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
  ).has((user.email || "").toLowerCase());

  const limit = parseInt(process.env.SEARCH_DAILY_LIMIT || "3", 10);
  const today = new Date().toISOString().slice(0, 10);
  const used = user.searchCountDay === today ? user.searchCount || 0 : 0;
  const remaining = isAdmin ? Infinity : Math.max(0, limit - used);
  return res.json({ authenticated: true, isAdmin, used, remaining, limit });
});

// -------------------------------
// 🟢 SERVER START
// -------------------------------
const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => console.log(`🚀 Server running on http://${HOST}:${PORT}`));
