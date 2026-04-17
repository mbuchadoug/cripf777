// server.js - CRIPFCnt SCOI Server (merged, updated)
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
import { createServer } from "http";
import { initializeLiveClassSocket } from "./services/liveClassSocket.js";
import Handlebars from "handlebars";
import consumerRoutes from "./routes/consumer.js";
import consumerQuizRoutes from "./routes/consumer_quiz.js";
import adminQuizRules from "./routes/admin_quiz_rules.js";
import adminExamRoutes from "./routes/admin_exams.js";
import publicCreatorQuizRoutes from "./routes/publicCreatorQuiz.js";
import creatorCampaignRoutes from "./routes/creatorCampaigns.js";

import parentRoutes from "./routes/parent.js";
import parentAttemptsRoutes from "./routes/parent_attempts.js";
import adminFinanceRoutes from "./routes/admin_finance.js";
import adminBattlesRouter from "./routes/adminBattles.js";
import { startBattleScheduler } from "./services/battleScheduler.js";

import twilioBizRoutes from "./routes/twilio_biz.js";

import privateTeacherRoutes from "./routes/privateTeacher.js";

//----------------------------------------businessWhtasapp
import cookieParser from "cookie-parser";
import webAuthRoutes from "./routes/web_auth.js";
import webDashboardRoutes from "./routes/web_dashboard.js";
import webInvoicesRoutes from "./routes/web_invoices.js";
import webProductsRoutes from "./routes/web_products.js";
import webClientsRoutes from "./routes/web_clients.js";
import webReportsRoutes from "./routes/web_reports.js";
import webFilesRoutes from "./routes/web_files.js";
import battleRoutes from "./routes/battles.js";
import webExpenses from "./routes/web_expenses.js";
import webSettings from "./routes/web_settings.js"; // ← ADD THIS
import webTeam from "./routes/web_team.js";          // ← ADD THIS
//-------------------------------------------------------

import {
  allowInsecurePrototypeAccess
} from "@handlebars/allow-prototype-access";
import specialScoiImportRoutes from "./routes/admin_special_scoi_import.js";

import metaWebhookRoutes from "./routes/meta_webhook.js";

// routes & utils
import lmsLoginRoutes from "./routes/lms_login.js";
import portalRoutes from "./routes/portal.js";
import scoiDownloadRoutes from "./routes/scoi_download.js";
import AuditPurchase from "./models/auditPurchase.js";
import PlacementAudit from "./models/placementAudit.js";

import { trackPageView } from "./middleware/analyticsTracker.js";
import adminAnalyticsRoutes from "./routes/admin_analytics.js";

import lmsImportRoutes from "./routes/lms_Import.js";
import adminCertificateRoutes from "./routes/admin_certificates.js";

import stripeWebhookRoutes from "./routes/stripe_webhook.js";
import billingRoutes from "./routes/billing.js";

import adminPlacementImport from "./routes/admin_placement_import.js";
import studentRoutes from "./routes/student.js";

import scoiMarketplaceRoutes from "./routes/scoi_marketplace.js";

import scoiCheckoutRoutes from "./routes/scoi_checkout.js";

import paymentsRouter from "./routes/payments.js";
import arenaRoutes from "./routes/arena.js";

// Add these imports
import adminScoiReports from "./routes/admin_scoi_reports.js";

import webPayments from "./routes/web_payments.js";
import webSubscription from "./routes/web_subscription.js"; // ← ADD






import employeeUpgradeRoutes from "./routes/employee_upgrade.js";



import trackRouter from "./routes/track.js";
import lmsRoutes from "./routes/lms.js";
// use the lms_api file that contains examInstance + attempt persistence
import lmsApiRoutes from "./routes/lms_api.js";
import adminRoutes from "./routes/admin.js"; // merged admin (includes import/upload UI)
import supplierAdminRoutes from "./routes/supplierAdmin.js"; // ← ADD THIS
import schoolAdminRoutes from "./routes/schoolAdmin.js";
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
import webReceipts from "./routes/web_receipts.js";
import cron from "node-cron";
import { autoCloseExpiredRequests } from "./services/buyerRequests.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// friendly support contact (configurable via .env)
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@cripfcnt.com";

// ⚠️ STRIPE WEBHOOK - MUST COME FIRST

// cron/buyerRequestCron.js
// ─── Auto-close expired buyer requests ───────────────────────────────────────
//
// SETUP:
//   npm install node-cron   (if not already installed)
//
// USAGE - add this to your server.js or app.js ONCE:
//
//   import "./cron/buyerRequestCron.js";
//
// That's it. The cron starts automatically when your server boots.
//
// ─────────────────────────────────────────────────────────────────────────────


// ── Run every 5 minutes ───────────────────────────────────────────────────────
// Closes requests older than 15 minutes and notifies buyers.
// The 15-minute window gives suppliers time to respond.
// Adjust timeoutMinutes to change the window (5 = fast, 30 = relaxed).

const TIMEOUT_MINUTES = 15;

cron.schedule("*/5 * * * *", async () => {
  try {
    const closed = await autoCloseExpiredRequests({
      timeoutMinutes: TIMEOUT_MINUTES,
      notifyBuyer:    true
    });
    if (closed > 0) {
      console.log(`[CRON ${new Date().toISOString()}] Auto-closed ${closed} expired buyer request(s)`);
    }
  } catch (err) {
    console.error("[CRON AUTO-CLOSE ERROR]", err.message);
  }
}, {
  timezone: "Africa/Harare"   // adjust if your server runs in UTC
});

console.log("[CRON] Buyer request auto-close cron started (every 5 min, timeout: 15 min)");


// ─── ALTERNATIVE: Serverless / no cron (trigger on every message) ─────────────
//
// If you're on Railway, Heroku, or another platform where cron is unreliable,
// add this ONE line at the very TOP of your handleIncoming() function in
// chatbotEngine.js, before any other logic:
//
//   autoCloseExpiredRequests({ timeoutMinutes: 15, notifyBuyer: true })
//     .catch(err => console.error("[AUTO-CLOSE BG]", err.message));
//
// This fires on every inbound WhatsApp message, is non-blocking, and costs
// one MongoDB query per message. At low volume this is fine.
//
// ─────────────────────────────────────────────────────────────────────────────
// Normal parsers for everything else
/*app.use(express.json());
app.use(express.urlencoded({ extended: true }));*/

// 1️⃣ Stripe webhook FIRST (raw body)
app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use("/stripe/webhook", stripeWebhookRoutes);




// Basic middleware
// Basic middleware - skip body parsing for multipart (multer handles those)
app.use((req, res, next) => {
  if (req.headers['content-type']?.startsWith('multipart/form-data')) return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use((req, res, next) => {
  if (req.headers['content-type']?.startsWith('multipart/form-data')) return next();
  express.urlencoded({ extended: true, limit: '10mb' })(req, res, next);
});
app.use(express.static(path.join(__dirname, "public")));
app.use("/docs", express.static(path.join(__dirname, "docs")));
app.use(cookieParser());
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
  // ✅ ADD THIS NEW HELPER:
  includes: (str, substr) => {
    if (!str || !substr) return false;
    return String(str).includes(String(substr));
  },
  not: (v) => !v,
  isNull: (v) => v === null || v === undefined,
  isNumber: (v) => typeof v === "number",
subtract: (a, b) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return x - y;
},
json: (context) => {
  return JSON.stringify(context);
},
// ✅ ADD THIS:
  math: (a, operator, b) => {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    
    switch (operator) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': return y !== 0 ? x / y : 0;
      case '%': return y !== 0 ? x % y : 0;
      default: return 0;
    }
  },

  substring: (str, start, len) => {
  if (str === null || str === undefined) return "";
  const s = String(str);
  const from = Number(start) || 0;

  // If len is provided, return that many chars, else return to end
  if (len === null || len === undefined) return s.substring(from);
  const n = Number(len);
  return s.substring(from, from + (Number.isFinite(n) ? n : 0));
},

 // ✅ ADD THIS CAPITALIZE HELPER
  capitalize: (str) => {
    if (!str || typeof str !== "string") return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
  },

  replace: (str, find, replace) => {
  return String(str || '').split(find).join(replace);
},
   // ✅ ADD SUM HELPER (for calculating averages)
  sum: (array, property) => {
    if (!Array.isArray(array)) return 0;
    if (!property) return array.reduce((sum, val) => sum + (Number(val) || 0), 0);
    return array.reduce((sum, obj) => sum + (Number(obj[property]) || 0), 0);
  },

  // ✅ ADD FORMATDATE HELPER (better formatting)
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
  letters: (i) => {
    if (typeof i !== "number" || i < 0) return "";
    const seq = "abcdefghijklmnopqrstuvwxyz";
    return seq.charAt(i) || String.fromCharCode(97 + i);
  },

  inc: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? (n + 1) : v;
  },

add: (a, b) => {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    return x + y;
  },

  divide: (a, b) => {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
    return (x / y).toFixed(3);
  },
  divideCents: (cents) => {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "0.00";
  return (n / 100).toFixed(2);
},
   // Helper to check current page
  currentPage: (req, page) => {
    return req.path.includes(page) ? 'active' : '';
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
    partialsDir: path.join(__dirname, "views/partials"),
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
  .then(() => {
    console.log("✅ Connected to MongoDB");

    // ✅ START SCHEDULER ONLY AFTER DB IS READY
    startBattleScheduler({
      enabled: process.env.BATTLE_SCHEDULER_ENABLED === "true",
      intervalMs: 30000,
      lockTtlMs: 25000
    });
  })
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

app.use(trackPageView);

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
app.use("/admin", adminAnalyticsRoutes);
app.use("/zq-admin", supplierAdminRoutes); // ← ADD THIS
app.use("/zq-admin", schoolAdminRoutes);
// API routes - keep LMS API on /api/lms so quiz UI fetches work
app.use("/api/lms", lmsApiRoutes);
app.use("/", creatorCampaignRoutes);

// Admin attempts UI
app.use("/", adminAttempts);

// Other API-level routes (tracking, etc.)
app.use("/api", trackRouter);

// Public LMS pages
app.use("/lms", lmsRoutes);
app.use("/admin", lmsImportRoutes);
app.use("/consumer", consumerRoutes);
app.use("/consumer", consumerQuizRoutes);
app.use("/meta", metaWebhookRoutes);


app.use("/admin", adminExamRoutes);
// ========================================
// 🌐 WEB PLATFORM ROUTES (NEW)
// ========================================
// Inject bot number for JOIN link on team page
app.use("/web", (req, res, next) => {
  res.locals.botNumber = (process.env.TWILIO_WHATSAPP_NUMBER || "").replace(/\D+/g, "");
  next();
});
app.use("/web", webAuthRoutes);
app.use("/web", webDashboardRoutes);
app.use("/web", webInvoicesRoutes);
app.use("/web", webProductsRoutes);
app.use("/web", webClientsRoutes);
app.use("/web", webReportsRoutes);
app.use("/web", webFilesRoutes);
app.use("/web", webExpenses);
app.use("/web", webPayments);
app.use("/web", webSubscription); // ← ADD
app.use("/web", webSettings); // ← ADD THIS
app.use("/web", webTeam);                            // ← ADD THIS
// Add this route registration
app.use(adminScoiReports);
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

app.use(adminBattlesRouter);
app.use(employeeUpgradeRoutes);
app.use("/api/org", apiOrgQuizRoutes);
app.use("/twilio_biz", twilioBizRoutes);
app.use("/web", webReceipts);
app.use(arenaRoutes);
// ... after other route registrations
app.use("/teacher", privateTeacherRoutes);
app.use(battleRoutes);
app.use(adminFinanceRoutes);
app.use(publicCreatorQuizRoutes);

app.use("/", parentAttemptsRoutes);

app.use(studentRoutes);

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

**4️⃣ Global Environment Adjustment - ERF: ${ERF}**  
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


// privacy & deletion pages
app.get("/privacy-policy", (req, res) => {
  res.render("privacy_policy", {
    title: "Privacy Policy – Cripfcnt",
    description: "Privacy policy for Cripfcnt - how we collect and handle data."
  });
});

app.get("/data-deletion", (req, res) => {
  res.render("data_deletion", {
    title: "Data Deletion Instructions – Cripfcnt",
    description: "How to request deletion of your account and personal data."
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

// Create HTTP server
const httpServer = createServer(app);

// Initialize Socket.IO for live classes
initializeLiveClassSocket(httpServer);

// Start server
httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`✅ Socket.IO initialized for live classes`);
  console.log(`✅ Video processing queue active`);
});