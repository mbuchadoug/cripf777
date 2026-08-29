import { Router } from "express";
import { runSupplierSearch } from "../services/supplierSearch.js";
import SupplierProfile from "../models/supplierProfile.js";

/* ============================================================================
   Public trades API for the zimqoute.co.zw tool pages.
   - GET  /api/plumbers?area=Harare      -> live active plumbers (same gating as
                                            the "find plumber" chatbot search)
   - GET  /api/trades?trade=electrician&area=Harare  -> generic, any trade
   - POST /api/trades/register           -> create a PENDING listing lead
                                            (invisible until activated on WhatsApp,
                                            so billing/flow are never bypassed)
   Read-only search reuses runSupplierSearch(), so results always match the bot.
   ========================================================================== */

const router = Router();

/* Proxy already sends Access-Control-Allow-Origin: * - do NOT set it again here
   (that caused a duplicate-header block before). Only answer the preflight. */
router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function badgeFor(s) {
  if (s.topSupplierBadge) return "⭐ Top rated";
  if (s.tier === "featured") return "Featured";
  if (s.verified) return "✓ Verified";
  if ((s.completedOrders || 0) >= 5) return "Trusted";
  return null;
}

function mapSupplier(s) {
  return {
    name: s.businessName || "Listed provider",
    area: (s.location && (s.location.area || s.location.city)) || "",
    city: (s.location && s.location.city) || "",
    badge: badgeFor(s),
    rating: s.rating || 0,
    reviews: s.reviewCount || 0
  };
  // NOTE: phone is deliberately NOT exposed - quote requests route through the
  // chatbot ("find plumber <area>") so the funnel + moderation stay intact.
}

/* ── Live plumbers (alias of /api/trades?trade=plumber) ─────────────────── */
router.get("/plumbers", async (req, res) => {
  await listTrade(req, res, "plumber");
});

/* ── Generic trade listing ─────────────────────────────────────────────── */
router.get("/trades", async (req, res) => {
  const trade = String(req.query.trade || "plumber").slice(0, 40);
  await listTrade(req, res, trade);
});

async function listTrade(req, res, trade) {
  try {
    const area = req.query.area ? String(req.query.area).slice(0, 40) : "";
    const results = await runSupplierSearch({ city: area, product: trade });
    const plumbers = (results || []).slice(0, 6).map(mapSupplier);
    res.json({ trade, area, count: plumbers.length, plumbers });
  } catch (err) {
    console.error("[trades list]", err.message);
    res.json({ trade, area: "", count: 0, plumbers: [] }); // fail soft - strip just hides
  }
}

/* ── Web registration lead (list on the web) ───────────────────────────────
   Creates a PENDING supplier profile: active:false, subscriptionStatus:"pending".
   It will NOT appear in search until the provider activates/pays via the normal
   WhatsApp flow (which findOne({phone}) picks up and continues). Nothing here
   bypasses billing or touches existing active suppliers. ── */
router.post("/trades/register", async (req, res) => {
  try {
    const b = req.body || {};
    const businessName = String(b.businessName || "").trim().slice(0, 100);
    let phone = String(b.phone || "").replace(/\s|-/g, "");
    const city = String(b.city || "").trim().slice(0, 40);
    const area = String(b.area || "").trim().slice(0, 60);
    const trade = String(b.trade || "plumbing").trim().toLowerCase().slice(0, 40);

    if (!businessName || !phone || !city || !area) {
      return res.status(400).json({ error: "Please fill in your business name, phone, city and area." });
    }
    // normalize ZW phone loosely (accept 07.., +263.., 263..)
    phone = phone.replace(/^\+?263/, "0");
    if (!/^0\d{8,9}$/.test(phone)) {
      return res.status(400).json({ error: "Please enter a valid phone number (e.g. 0771234567)." });
    }

    const existing = await SupplierProfile.findOne({ phone }).lean();
    if (existing) {
      return res.json({
        ok: true, alreadyListed: true,
        message: "You're already in our system - open WhatsApp to finish setup or update your listing."
      });
    }

    await SupplierProfile.create({
      phone,
      businessName,
      location: { city, area },
      categories: [trade],
      products: [trade],
      profileType: "service",
      sector: "service",
      tier: "basic",
      tierRank: 1,
      subscriptionStatus: "pending",
      active: false,
      verified: false,
      source: "web-listing"
    });

    return res.json({
      ok: true,
      message: "You're on the list! Open WhatsApp to activate your free listing and start getting job requests."
    });
  } catch (err) {
    console.error("[trades register]", err.message);
    return res.status(500).json({ error: "Could not save your listing. Please try again or use WhatsApp." });
  }
});

export default router;