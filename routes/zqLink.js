// routes/zqLink.js
// ─── ZimQuote Smart Card - WhatsApp Deep-Link Redirector ─────────────────────
//
// Every school and seller has a shareable link:
//   /s/:slug   → school   → fires WhatsApp bot pre-loaded with school profile
//   /p/:slug   → supplier → fires WhatsApp bot pre-loaded with supplier profile
//
// The link is 100% WhatsApp - no website profile page, no web form.
// When tapped (on any platform, any device):
//   1. A minimal branded page loads instantly (< 5KB, works on EDGE)
//   2. JavaScript fires the wa.me deep-link in the same tick
//   3. WhatsApp opens and the ZimQuote bot immediately shows the full profile
//   4. On desktop (no WhatsApp), the page shows a QR code to scan on mobile
//
// Optional query params:
//   ?src=tiktok|facebook|twitter|qr|sms|direct  → tracked in lead record
//   ?action=fees|visit|place|pdf|enquiry         → bot jumps to that action
//   ?name=Tendai%20Moyo                          → bot pre-fills parent name
//   ?grade=Grade%203                             → bot pre-fills grade interest
//
// Mount in app.js:
//   import zqLinkRouter from "./routes/zqLink.js";
//   app.use("/s", zqLinkRouter);
//   app.use("/p", zqLinkRouter);
//
// SchoolProfile must have: zqSlug (String, unique, sparse)

import express         from "express";
import SchoolProfile   from "../models/schoolProfile.js";
import SupplierProfile from "../models/supplierProfile.js";
import SchoolLead      from "../models/schoolLead.js";

const router = express.Router();

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263789901058").replace(/\D/g, "");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function _normalizePhone(raw = "") {
  let p = String(raw).replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  return p;
}

// Build the wa.me payload sent to the bot
// Format: ZQ:SCHOOL:<id>[:<action>[:name=<name>][:grade=<grade>]]
function _buildPayload(type, id, action, name, grade) {
  let payload = `ZQ:${type}:${id}`;
  if (action && action !== "view") payload += `:${action}`;
  if (name)  payload += `:name=${encodeURIComponent(name)}`;
  if (grade) payload += `:grade=${encodeURIComponent(grade)}`;
  return payload;
}

function _waUrl(payload) {
  return `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent(payload)}`;
}

function _feeLabel(entity) {
  if (entity.fees?.term1) return `$${entity.fees.term1}/term`;
  return { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[entity.feeRange] || "";
}

function _sourceLabel(src) {
  return { tiktok:"TikTok", facebook:"Facebook", twitter:"Twitter/X",
    whatsapp_status:"WhatsApp Status", qr:"QR Poster", sms:"SMS",
    direct:"Direct Link" }[src] || "Direct Link";
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Build the redirect page HTML
// ─────────────────────────────────────────────────────────────────────────────
function _redirectPage({ name, subtitle, admissionsOpen, waUrl, payload, canonical, type }) {
  const typeLabel  = type === "school" ? "school" : "seller";
  const icon       = type === "school" ? "🏫" : "🏪";
  const admBadge   = type === "school"
    ? (admissionsOpen
        ? `<div class="adm-badge open">🟢 Admissions Open</div>`
        : `<div class="adm-badge closed">🔴 Admissions Closed</div>`)
    : "";

  // QR code for desktop users (points to the canonical URL itself so they can
  // scan from their phone and open WhatsApp on mobile)
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(canonical)}&color=085041&bgcolor=FFFFFF&qzone=1`;

  // Open Graph / Twitter Card meta - description + image for social previews
  const ogTitle = `${name} | ZimQuote`;
  const ogDesc  = type === "school"
    ? `${subtitle}. Tap to view fees, facilities and enquire on WhatsApp via ZimQuote.`
    : `${subtitle}. Tap to view products and chat on WhatsApp via ZimQuote.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ogTitle)}</title>
<meta name="description" content="${esc(ogDesc)}">
<link rel="canonical" href="${esc(canonical)}">
<!-- Open Graph (Facebook, WhatsApp link preview, LinkedIn) -->
<meta property="og:type"        content="website">
<meta property="og:url"         content="${esc(canonical)}">
<meta property="og:title"       content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:site_name"   content="ZimQuote">
<meta property="og:locale"      content="en_ZW">
<!-- Twitter / X Card -->
<meta name="twitter:card"        content="summary">
<meta name="twitter:title"       content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">
<meta name="twitter:site"        content="@ZimQuote">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0faf5;color:#1a2e1a}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;min-height:100vh}
.card{width:100%;max-width:400px;background:#fff;border-radius:20px;padding:28px;box-shadow:0 2px 24px rgba(0,40,20,.1);text-align:center}
.brand{font-size:12px;font-weight:700;color:#0F6E56;letter-spacing:.08em;text-transform:uppercase;margin-bottom:20px}
.avatar{width:64px;height:64px;border-radius:16px;background:#E1F5EE;color:#0F6E56;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;margin:0 auto 14px}
.entity-name{font-size:20px;font-weight:700;color:#0a1a0a;margin-bottom:6px;line-height:1.2}
.subtitle{font-size:13px;color:#5a7a5a;margin-bottom:12px;line-height:1.5}
.adm-badge{display:inline-block;font-size:12px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:18px}
.adm-badge.open{background:#E1F5EE;color:#0F6E56}
.adm-badge.closed{background:#FCEBEB;color:#A32D2D}
.wa-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:15px 20px;background:#25D366;color:#fff;text-decoration:none;border-radius:12px;font-size:16px;font-weight:700;margin-bottom:10px;transition:opacity .15s}
.wa-btn:hover{opacity:.88}
.wa-btn svg{flex-shrink:0}
.hint{font-size:12px;color:#7a9a7a;margin-bottom:22px}
.divider{height:1px;background:#eef5ee;margin:20px 0}
.desktop-section{display:none}
.qr-label{font-size:13px;color:#5a7a5a;margin-bottom:12px}
.qr-img{border:1px solid #e0ede0;border-radius:10px;padding:8px;display:inline-block}
.qr-img img{display:block;width:160px;height:160px}
.scan-tip{font-size:11px;color:#9aaa9a;margin-top:8px;line-height:1.5}
.powered{font-size:11px;color:#9aaa9a;margin-top:22px}
.powered a{color:#0F6E56;text-decoration:none}
.spinner{width:20px;height:20px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
@media(hover:none){.desktop-section{display:none!important}}
</style>
</head>
<body>
<div class="card">
  <div class="brand">ZimQuote · Zimbabwe's school &amp; business finder</div>

  <div class="avatar">${icon}</div>
  <h1 class="entity-name">${esc(name)}</h1>
  <p class="subtitle">${esc(subtitle)}</p>
  ${admBadge}

  <!-- Primary CTA - fires WhatsApp immediately -->
  <a href="${esc(waUrl)}" class="wa-btn" id="waBtn">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.625.846 5.059 2.284 7.034L.785 23.516a.75.75 0 001.012.86l4.612-1.63A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-2.347 0-4.536-.67-6.387-1.83l-.452-.267-3.35 1.184 1.139-3.267-.293-.466A9.96 9.96 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
    Open in WhatsApp
  </a>
  <p class="hint">Opens the ZimQuote bot · Your profile loads instantly</p>

  <!-- Desktop fallback - shown when no WhatsApp deep-link fires -->
  <div class="divider"></div>
  <div class="desktop-section" id="desktopSection">
    <p class="qr-label">📱 On your phone? Scan this QR code to open in WhatsApp:</p>
    <div class="qr-img"><img src="${esc(qrUrl)}" alt="QR Code" loading="lazy" width="160" height="160"></div>
    <p class="scan-tip">Open WhatsApp → Camera → Scan · Works on any phone</p>
  </div>

  <div class="powered"><a href="https://zimquote.co.zw" target="_blank" rel="noopener">Powered by ZimQuote</a></div>
</div>

<script>
// Fire the WhatsApp deep-link immediately on page load
// The href on the button is the fallback if JS fires after the user already tapped
(function() {
  var waUrl = ${JSON.stringify(waUrl)};
  var isMobile = /Android|iPhone|iPad|iPod|WhatsApp/i.test(navigator.userAgent);

  if (isMobile) {
    // On mobile: redirect immediately
    window.location.href = waUrl;
  } else {
    // On desktop: show the QR section so they can scan on their phone
    var ds = document.getElementById("desktopSection");
    if (ds) ds.style.display = "block";
  }

  // Show a spinner on the button while WA opens
  var btn = document.getElementById("waBtn");
  if (btn) {
    btn.addEventListener("click", function() {
      setTimeout(function() {
        btn.innerHTML = '<div class="spinner"></div> Opening WhatsApp...';
      }, 100);
    });
  }
})();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPECIFIC ROUTES FIRST - before /:slug catch-all
// ─────────────────────────────────────────────────────────────────────────────

// ── Lead conversion tracker - POST /s/:slug/track ────────────────────────────
// Called by the page before firing the wa.me link (optional, best-effort)
router.post("/:slug/track", async (req, res) => {
  try {
    const isSupplier = req.baseUrl.startsWith("/p");
    const slug   = req.params.slug.toLowerCase().trim();
    const source = String(req.body.source || "direct").slice(0, 30);
    const action = String(req.body.action || "view").slice(0, 20);

    if (!isSupplier) {
      const school = await SchoolProfile.findOne({ zqSlug: slug }).lean();
      if (school) {
        SchoolProfile.findByIdAndUpdate(school._id, {
          $inc: { zqLinkConversions: 1 }
        }).catch(() => {});
        // Create a lightweight lead record so the school sees it in their dashboard
        SchoolLead.create({
          schoolId: school._id, schoolPhone: school.phone,
          schoolName: school.schoolName, zqSlug: slug,
          parentName: String(req.body.name || "").trim().slice(0, 80),
          parentPhone: _normalizePhone(req.body.phone || ""),
          actionType: action, source,
          pageViewed: true, waOpened: true,
          nameEntered: !!(req.body.name || "").trim(),
          contacted: false
        }).catch(() => {});
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ── QR poster - GET /s/:slug/qr ──────────────────────────────────────────────
router.get("/:slug/qr", async (req, res) => {
  try {
    const isSupplier = req.baseUrl.startsWith("/p");
    const slug   = req.params.slug.toLowerCase().trim();
    const entity = isSupplier
      ? await SupplierProfile.findOne({ zqSlug: slug }).lean()
      : await SchoolProfile.findOne({ zqSlug: slug }).lean();
    if (!entity) return res.status(404).send("Profile not found.");

    const name    = entity.schoolName || entity.businessName || "";
    const payload = isSupplier
      ? _buildPayload("SUPPLIER", String(entity._id))
      : _buildPayload("SCHOOL", String(entity._id));
    const waUrl  = _waUrl(payload);
    const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(waUrl)}&color=085041&bgcolor=FFFFFF&qzone=2`;
    const loc    = [entity.suburb, entity.city].filter(Boolean).join(", ");
    const feeStr = _feeLabel(entity);

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>QR Poster – ${esc(name)}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,"Segoe UI",sans-serif;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}.poster{width:400px;border:3px solid #085041;border-radius:20px;padding:28px;text-align:center}.brand{font-size:11px;font-weight:700;color:#0F6E56;letter-spacing:.1em;text-transform:uppercase;margin-bottom:16px}h1{font-size:22px;font-weight:800;color:#0a1a0a;margin-bottom:6px;line-height:1.2}.sub{font-size:13px;color:#5a7a5a;margin-bottom:4px}.adm{display:inline-block;margin:10px 0 0;background:#E1F5EE;color:#0F6E56;font-size:12px;font-weight:700;padding:5px 14px;border-radius:20px}.adm.closed{background:#fee2e2;color:#dc2626}.qrw{margin:18px auto;padding:12px;border:1px solid #E1F5EE;border-radius:12px;display:inline-block}.qrw img{display:block;width:200px;height:200px}.cta{font-size:13px;font-weight:600;color:#0F6E56;margin-bottom:6px}.how{font-size:12px;color:#888;background:#f0faf5;border-radius:8px;padding:8px 12px;margin-bottom:14px;line-height:1.5}.foot{font-size:10px;color:#aaa}.noprint{margin-top:16px;display:flex;gap:10px;justify-content:center}@media print{.noprint{display:none!important}body{padding:0}}</style>
</head><body>
<div class="poster">
  <div class="brand">ZimQuote · Verified ${isSupplier ? "Seller" : "School"}</div>
  <h1>${esc(name)}</h1>
  <p class="sub">📍 ${esc(loc)}</p>
  ${feeStr?`<p class="sub">${esc(feeStr)}</p>`:""}
  <span class="adm ${entity.admissionsOpen===false?"closed":""}">${entity.admissionsOpen===false?"🔴 Admissions Closed":"🟢 Admissions Open"}</span>
  <div class="qrw"><img src="${esc(qrUrl)}" alt="Scan to open on WhatsApp"></div>
  <p class="cta">📲 Scan to open on WhatsApp instantly</p>
  <div class="how">Open WhatsApp → tap Camera icon → scan this code<br>Your school profile opens in the chat immediately.</div>
  <div class="foot">Powered by ZimQuote · zimquote.co.zw</div>
</div>
<div class="noprint">
  <button onclick="window.print()" style="padding:10px 20px;background:#085041;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">🖨️ Print Poster</button>
  <a href="javascript:history.back()" style="padding:10px 20px;background:#e2e8f0;color:#475569;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none">← Back</a>
</div>
</body></html>`);
  } catch (err) {
    res.status(500).send(`<p>Error: ${err.message}</p>`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL REDIRECT - GET /s/:slug  (catch-all, must be last)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:slug", async (req, res) => {
  try {
    const isSupplier = req.baseUrl.startsWith("/p");
    const slug   = req.params.slug.toLowerCase().trim();
    const source = String(req.query.src    || "direct").slice(0, 30);
    const action = String(req.query.action || "view").slice(0, 20);
    const name   = String(req.query.name   || "").slice(0, 80);
    const grade  = String(req.query.grade  || "").slice(0, 30);

    if (isSupplier) {
      const supplier = await SupplierProfile.findOne({ zqSlug: slug }).lean();
      if (!supplier) return res.status(404).send(_notFoundPage(slug));

      SupplierProfile.findByIdAndUpdate(supplier._id, { $inc: { zqLinkViews: 1 } }).catch(() => {});

      // Derive canonical from request so it always shows the correct domain
      const base      = _baseUrl(req);
      const canonical = `${base}/p/${slug}${source !== "direct" ? "?src="+source : ""}`;
      const payload   = _buildPayload("SUPPLIER", String(supplier._id), action, name, grade);
      const waUrl     = _waUrl(payload);
      const products  = (supplier.products || []).slice(0, 4).join(" · ") || "";

      return res.send(_redirectPage({
        name:     supplier.businessName,
        subtitle: [supplier.area, supplier.city].filter(Boolean).join(", ") + (products ? " · " + products : ""),
        admissionsOpen: null,
        waUrl, payload, canonical,
        type: "supplier"
      }));
    }

    // ── School ────────────────────────────────────────────────────────────────
    const school = await SchoolProfile.findOne({ zqSlug: slug }).lean();
    if (!school) return res.status(404).send(_notFoundPage(slug));

    // Track view
    SchoolProfile.findByIdAndUpdate(school._id, {
      $inc: { monthlyViews: 1, zqLinkViews: 1 }
    }).catch(() => {});

    // Log page view as a lead stub
    SchoolLead.create({
      schoolId: school._id, schoolPhone: school.phone,
      schoolName: school.schoolName, zqSlug: slug,
      parentName: name, source, actionType: "view",
      pageViewed: true, waOpened: false
    }).catch(() => {});

    const base      = _baseUrl(req);
    const canonical = `${base}/s/${slug}${source !== "direct" ? "?src="+source : ""}`;
    const payload   = _buildPayload("SCHOOL", String(school._id), action, name, grade);
    const waUrl     = _waUrl(payload);

    const TL = { ecd:"ECD / Preschool", ecd_primary:"ECD + Primary", primary:"Primary School", secondary:"Secondary School", combined:"Combined School" };
    const fee = _feeLabel(school);
    const cur = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "ZIMSEC";
    const subtitle = [
      TL[school.type] || "School",
      [school.suburb, school.city].filter(Boolean).join(", "),
      fee,
      cur
    ].filter(Boolean).join(" · ");

    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(_redirectPage({
      name: school.schoolName,
      subtitle,
      admissionsOpen: school.admissionsOpen,
      waUrl, payload, canonical,
      type: "school"
    }));
  } catch (err) {
    console.error("[ZQ Link] GET error:", err.message);
    res.status(500).send(_errorPage());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function _baseUrl(req) {
  if (process.env.SITE_URL)      return process.env.SITE_URL.replace(/\/$/, "");
  if (process.env.APP_BASE_URL)  return process.env.APP_BASE_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"]  || req.get("host") || "zimquote.co.zw";
  return `${proto}://${host}`;
}

function _notFoundPage(slug) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found | ZimQuote</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0faf5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.c{background:#fff;border-radius:16px;padding:32px;max-width:400px;width:100%;text-align:center;box-shadow:0 2px 20px rgba(0,40,20,.1)}h2{font-size:20px;margin-bottom:10px;color:#333}p{color:#666;font-size:14px;margin-bottom:20px;line-height:1.6}a{display:inline-block;padding:12px 24px;background:#1D9E75;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px}</style>
</head><body><div class="c"><div style="font-size:48px;margin-bottom:16px">🔍</div><h2>Profile not found</h2><p>This ZimQuote link <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px">${esc(slug)}</code> does not exist or may have changed.</p><a href="https://wa.me/${BOT_NUMBER}?text=Hi+ZimQuote">Search on ZimQuote →</a></div></body></html>`;
}

function _errorPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Error | ZimQuote</title></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Something went wrong</h2><p style="margin:16px 0">Please try again or <a href="https://wa.me/${BOT_NUMBER}?text=Hi+ZimQuote">chat with us on WhatsApp</a>.</p></body></html>`;
}

export default router;