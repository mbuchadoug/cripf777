// integration/register_8qt.js
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO WIRE THE 8QT SYSTEM INTO YOUR EXISTING APP
// Add these instructions to your main app.js / server.js
// ─────────────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════
// 1. ROUTE REGISTRATION
// In your main app.js, import and mount:
// ══════════════════════════════════════════════════════════════

/*
import eightQTRoutes from "./routes/eightQT.js";
import eightQTAdminRoutes from "./routes/eightQTAdmin.js";

// Public 8QT routes (no auth required)
app.use("/8qt", eightQTRoutes);

// Admin routes (auth enforced inside the router)
app.use("/admin/8qt", eightQTAdminRoutes);
*/

// ══════════════════════════════════════════════════════════════
// 2. STRIPE WEBHOOK EXTENSION
// In your existing routes/stripe_webhook.js, inside the
// checkout.session.completed handler, add:
// ══════════════════════════════════════════════════════════════

/*
import { handle8QTCertificate } from "./stripe_webhook_8qt.js";

// Inside the event handler:
if (event.type === "checkout.session.completed") {
  const session = event.data.object;
  const meta = session.metadata || {};

  // ... your existing handlers ...

  // ADD THIS:
  if (meta.type === "8qt_certificate") {
    await handle8QTCertificate(session);
  }
}
*/

// ══════════════════════════════════════════════════════════════
// 3. HANDLEBARS HELPERS
// Register these helpers in your hbs setup:
// ══════════════════════════════════════════════════════════════

/*
import { engine } from "express-handlebars";

const hbs = engine({
  helpers: {
    // Existing helpers ...

    // 8QT helpers:
    add: (a, b) => Number(a) + Number(b),

    letterFromIndex: (index) => ["A","B","C","D"][index] || String(index + 1),

    round: (val) => Math.round(Number(val) || 0),

    formatDate: (date) => {
      if (!date) return "";
      return new Date(date).toLocaleDateString("en-GB", {
        day: "numeric", month: "long", year: "numeric"
      });
    },

    eq: (a, b) => a === b,

    // Lookup a value from a nested context (for radar colors in results.hbs)
    lookup: (obj, key, prop) => {
      if (!obj || !key) return "";
      const item = obj[key];
      if (!item) return "";
      return prop ? item[prop] : item;
    }
  }
});
*/

// ══════════════════════════════════════════════════════════════
// 4. HOMEPAGE LINK
// In your index.hbs hero / nav section, add a prominent CTA:
// ══════════════════════════════════════════════════════════════

/*
  <a href="/8qt" class="nav-cta">Take the 8QT</a>

  OR as a hero section banner:

  <div class="hero-cta-banner">
    <div class="banner-label">New — Free Assessment</div>
    <a href="/8qt" class="banner-btn">
      Discover Your 8 Quotients →
    </a>
  </div>
*/

// ══════════════════════════════════════════════════════════════
// 5. STATIC FILES
// Serve the certificates directory:
// ══════════════════════════════════════════════════════════════

/*
import path from "path";
app.use("/certificates", express.static(path.join(process.cwd(), "public", "certificates")));
*/

// ══════════════════════════════════════════════════════════════
// 6. ENVIRONMENT VARIABLES NEEDED
// Ensure these are in your .env:
// ══════════════════════════════════════════════════════════════

/*
SITE_URL=https://cripfcnt.com
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
ADMIN_EMAILS=admin@cripfcnt.com
*/

// ══════════════════════════════════════════════════════════════
// 7. FIRST-TIME SETUP SEQUENCE
// After deploying, run these in order:
// ══════════════════════════════════════════════════════════════

/*
1. POST /admin/8qt/config/seed           → creates 8 default quotient configs
2. POST /admin/8qt/template              → creates default certificate template
3. POST /admin/8qt/questions/import      → upload your question bank CSV
4. POST /admin/8qt/archetypes            → create archetype templates via admin panel
5. Visit /8qt                            → test the full participant flow
6. Add webhook endpoint in Stripe dashboard: POST /webhook/stripe
*/

// ══════════════════════════════════════════════════════════════
// 8. SAMPLE ARCHETYPE (POST body for /admin/8qt/archetypes)
// ══════════════════════════════════════════════════════════════

/*
{
  "name": "The Responsible Builder",
  "tagline": "You see obligation where others see noise",
  "description": "You consistently default to ownership rather than deflection. When a problem surfaces, your first instinct is to ask what role you can play, not who is to blame. This orientation makes you a stabilising force in most environments — people know that if you say something will be done, it will be.",
  "reflectionPrompts": [
    "Where in your life might your strong sense of responsibility be absorbing other people's accountability?",
    "What would it look like to delegate responsibility without losing ownership of outcomes?",
    "How do you decide which problems are yours to solve versus yours to observe?"
  ],
  "conditions": [
    { "quotient": "RQ", "operator": "gte", "value": 70 },
    { "quotient": "PQ", "operator": "gte", "value": 60 }
  ],
  "priority": 80,
  "active": true
}
*/

/*
{
  "name": "The Emerging Thinker",
  "tagline": "Every map begins somewhere",
  "description": "Your 8 Quotients profile suggests you are at the beginning of a placement intelligence journey. This is not a weakness — it is the most honest starting point. CRIPFCnt was built for exactly this moment: the point where someone realises that intelligence alone does not explain outcomes, and begins to ask different questions.",
  "reflectionPrompts": [
    "Which of the 8 quotients surprised you most when you saw your score?",
    "What situation in your life would look different if you applied a placement lens to it?",
    "What would you do differently if you knew your effort was misplaced rather than insufficient?"
  ],
  "conditions": [],
  "isDefault": true,
  "priority": 0,
  "active": true
}
*/

export default {};
