// routes/zqLink.js
// ─── ZimQuote Smart Card — Public Lead-Capture Profile Pages ─────────────────
//
// Mount in app.js:
//   import zqLinkRouter from "./routes/zqLink.js";
//   app.use("/s", zqLinkRouter);   // schools
//   app.use("/p", zqLinkRouter);   // suppliers
//
// ROUTE ORDER IS CRITICAL — specific routes must come before /:slug catch-all:
//   POST /:slug/capture   (lead save + WA redirect)
//   GET  /:slug/qr        (QR poster page)
//   GET  /:slug/og.png    (OG preview image — called by social crawlers)
//   GET  /:slug           (Smart Card page — catch-all, must be last)
//
// ENV VARS (all optional — page works with zero config):
//   WHATSAPP_BOT_NUMBER   — the ZimQuote bot number (digits only or +263...)
//   SITE_URL              — if set, used for canonical/OG URLs instead of req.host
//
// SchoolProfile must have: zqSlug (String), zqLinkViews (Number), zqLinkConversions (Number)

import express         from "express";
import SchoolProfile   from "../models/schoolProfile.js";
import SupplierProfile from "../models/supplierProfile.js";
import SchoolLead      from "../models/schoolLead.js";
import {
  notifySchoolNewLead,
  notifySchoolVisitRequest,
  notifySchoolPlaceEnquiry
} from "../services/schoolNotifications.js";

const router = express.Router();
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263789901058").replace(/\D/g, "");

// ── Derive the correct base URL from the live request ────────────────────────
// This means the Smart Card works correctly on any domain — cripfcnt.com during
// development, zimquote.co.zw in production — without touching env vars.
// If SITE_URL is set (e.g. https://zimquote.co.zw), that overrides everything.
function _baseUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"]  || req.get("host") || "zimquote.co.zw";
  return `${proto}://${host}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function _normalizeZimPhone(raw = "") {
  let p = String(raw).replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  return p;
}
function _feeLabel(school) {
  if (school.fees?.term1) return `$${school.fees.term1}/term`;
  return { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[school.feeRange] || "Fees on request";
}
function _facilitySnippet(facs = []) {
  const M = {
    swimming_pool:"Pool", science_lab:"Science Lab", computer_lab:"Computer Lab",
    library:"Library", sports_fields:"Sports Fields", wifi:"Wi-Fi",
    boarding_house:"Boarding", transport:"Transport", gymnasium:"Gym",
    auditorium:"Hall", medical_centre:"Medical", chapel:"Chapel"
  };
  return facs.slice(0,5).map(id => M[id]||id).join(" · ");
}
function _sourceLabel(src) {
  return {
    tiktok:"TikTok", facebook:"Facebook", twitter:"Twitter/X",
    whatsapp_status:"WhatsApp Status", qr:"QR Poster", sms:"SMS", direct:"Direct Link"
  }[src] || "Direct Link";
}
function _schoolDesc(school) {
  const TL = { ecd:"ECD/Preschool", ecd_primary:"ECD + Primary", primary:"Primary School", secondary:"Secondary School", combined:"Combined School" };
  const cur = (school.curriculum||[]).map(c=>c.toUpperCase()).join(" + ")||"ZIMSEC";
  const fee = _feeLabel(school);
  const loc = [school.suburb, school.city].filter(Boolean).join(", ");
  return `${school.schoolName} – ${TL[school.type]||"School"} in ${loc}. ${cur}. ${fee}. ${school.admissionsOpen?"Admissions open.":""} Chat and apply via ZimQuote.`;
}

// ── OG Image generator — returns an SVG that social crawlers accept ───────────
// Called as /s/:slug/og.png but returns an SVG with image/svg+xml content type.
// Facebook, Twitter/X, WhatsApp, LinkedIn all accept SVG for og:image when
// the URL returns it with the right content-type.
function _ogImageSvg(name, city, suburb, type, fee, admissionsOpen) {
  const loc   = [suburb, city].filter(Boolean).join(", ");
  const adm   = admissionsOpen ? "Admissions Open" : "Admissions Closed";
  const admBg = admissionsOpen ? "#1D9E75" : "#dc2626";
  // Truncate long names so they fit
  const shortName = name.length > 28 ? name.slice(0, 26) + "…" : name;
  const shortLoc  = loc.length  > 36 ? loc.slice(0, 34)  + "…" : loc;
  const shortType = String(type||"School").length > 30 ? String(type||"School").slice(0,28)+"…" : (type||"School");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f0faf5"/>
  <rect x="0" y="0" width="8" height="630" fill="#1D9E75"/>
  <rect x="60" y="60" width="1080" height="510" rx="24" fill="white" stroke="#c8dac8" stroke-width="1"/>
  <!-- ZimQuote brand -->
  <text x="100" y="122" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="22" font-weight="700" fill="#1D9E75" letter-spacing="0.5">ZimQuote</text>
  <text x="100" y="148" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="14" fill="#7a9a7a">Zimbabwe&apos;s School &amp; Business Finder</text>
  <!-- Divider -->
  <line x1="100" y1="172" x2="1100" y2="172" stroke="#eef5ee" stroke-width="1"/>
  <!-- Avatar circle -->
  <rect x="100" y="196" width="80" height="80" rx="16" fill="#E1F5EE"/>
  <text x="140" y="249" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="28" font-weight="700" fill="#0F6E56" text-anchor="middle">${esc(shortName.slice(0,2).toUpperCase())}</text>
  <!-- School name -->
  <text x="200" y="232" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="42" font-weight="700" fill="#0a1a0a">${esc(shortName)}</text>
  <text x="200" y="268" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="22" fill="#5a7a5a">📍 ${esc(shortLoc)}</text>
  <!-- Admissions badge -->
  <rect x="100" y="302" width="${admissionsOpen ? 220 : 250}" height="40" rx="20" fill="${admBg}"/>
  <text x="${admissionsOpen ? 210 : 225}" y="328" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="18" font-weight="600" fill="white" text-anchor="middle">${adm}</text>
  <!-- Info row -->
  <text x="100" y="400" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="18" fill="#7a9a7a" font-weight="600" text-transform="uppercase">TYPE</text>
  <text x="100" y="428" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="22" font-weight="600" fill="#1a2e1a">${esc(shortType)}</text>
  <text x="420" y="400" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="18" fill="#7a9a7a" font-weight="600">FEES PER TERM</text>
  <text x="420" y="428" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="22" font-weight="600" fill="#1D9E75">${esc(fee)}</text>
  <!-- CTA bar -->
  <rect x="60" y="500" width="1080" height="70" rx="0 0 24 24" fill="#1D9E75"/>
  <rect x="60" y="500" width="1080" height="70" fill="#1D9E75"/>
  <rect x="60" y="500" width="1080" height="70" rx="0" fill="#1D9E75"/>
  <path d="M60 500 h1080 v46 q0 24 -24 24 H84 q-24 0 -24 -24 Z" fill="#1D9E75"/>
  <text x="600" y="543" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="22" font-weight="600" fill="white" text-anchor="middle">Tap to view fees, facilities &amp; enquire on WhatsApp</text>
</svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// !! SPECIFIC ROUTES FIRST — before the /:slug catch-all !!
// ─────────────────────────────────────────────────────────────────────────────

// ── OG image route — GET /s/:slug/og.png (called by social crawlers) ─────────
router.get("/:slug/og.png", async (req, res) => {
  try {
    const isSupplier = req.baseUrl.startsWith("/p");
    const slug = req.params.slug.toLowerCase().trim();
    const entity = isSupplier
      ? await SupplierProfile.findOne({ zqSlug: slug }).lean()
      : await SchoolProfile.findOne({ zqSlug: slug }).lean();

    if (!entity) {
      // Return a generic ZimQuote OG image
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <rect width="1200" height="630" fill="#f0faf5"/>
        <rect x="60" y="60" width="1080" height="510" rx="24" fill="white"/>
        <text x="600" y="280" font-family="sans-serif" font-size="56" font-weight="700" fill="#1D9E75" text-anchor="middle">ZimQuote</text>
        <text x="600" y="340" font-family="sans-serif" font-size="26" fill="#5a7a5a" text-anchor="middle">Zimbabwe&apos;s School &amp; Business Finder</text>
        <text x="600" y="430" font-family="sans-serif" font-size="20" fill="#7a9a7a" text-anchor="middle">Find schools, compare fees, enquire via WhatsApp</text>
      </svg>`);
    }

    const name  = entity.schoolName || entity.businessName || "";
    const type  = { ecd:"ECD / Preschool", ecd_primary:"ECD + Primary", primary:"Primary School",
                    secondary:"Secondary School", combined:"Combined School" }[entity.type] || "School";
    const fee   = entity.fees?.term1 ? `$${entity.fees.term1}/term`
                : { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[entity.feeRange] || "Fees on request";

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(_ogImageSvg(name, entity.city, entity.suburb, type, fee, entity.admissionsOpen));
  } catch (err) {
    res.status(500).send(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#f0faf5"/><text x="600" y="315" font-family="sans-serif" font-size="32" fill="#333" text-anchor="middle">ZimQuote</text></svg>`);
  }
});

// ── Lead capture — POST /s/:slug/capture ─────────────────────────────────────
router.post("/:slug/capture", async (req, res) => {
  try {
    const isSupplier = req.baseUrl.startsWith("/p");
    if (isSupplier) return _captureSupplierLead(req, res, req.params.slug);

    const slug   = req.params.slug.toLowerCase().trim();
    const school = await SchoolProfile.findOne({ zqSlug: slug }).lean();
    if (!school) return res.status(404).json({ error: "Not found" });

    const parentName    = String(req.body.parentName    || "").trim().slice(0, 80);
    const action        = String(req.body.action        || "enquiry").trim();
    const gradeInterest = String(req.body.gradeInterest || "").trim().slice(0, 30);
    const source        = String(req.body.source        || "direct").trim().slice(0, 30);
    const parentPhone   = _normalizeZimPhone(req.body.parentPhone || "");
    const srcLabel      = _sourceLabel(source);

    await SchoolLead.create({
      schoolId: school._id, schoolPhone: school.phone,
      schoolName: school.schoolName, zqSlug: slug,
      parentName, parentPhone, actionType: action,
      gradeInterest, source, pageViewed: true,
      waOpened: true, nameEntered: !!parentName, contacted: false
    });

    SchoolProfile.findByIdAndUpdate(school._id, {
      $inc: { zqLinkConversions: 1 }
    }).catch(() => {});

    const displayName = parentName || parentPhone || "A parent";
    if (action === "visit") {
      notifySchoolVisitRequest(school.phone, school.schoolName, displayName, srcLabel).catch(() => {});
    } else if (action === "place") {
      notifySchoolPlaceEnquiry(school.phone, school.schoolName, displayName, gradeInterest, srcLabel).catch(() => {});
    } else {
      notifySchoolNewLead(school.phone, school.schoolName, displayName, action, srcLabel).catch(() => {});
    }

    let payload = `ZQ:SCHOOL:${school._id}:${action}`;
    if (parentName)    payload += `:name=${encodeURIComponent(parentName)}`;
    if (gradeInterest) payload += `:grade=${encodeURIComponent(gradeInterest)}`;

    res.json({ redirect: `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent(payload)}` });
  } catch (err) {
    console.error("[ZQ SmartCard] capture error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── QR poster — GET /s/:slug/qr ──────────────────────────────────────────────
router.get("/:slug/qr", async (req, res) => {
  try {
    const isSupplier = req.baseUrl.startsWith("/p");
    const slug   = req.params.slug.toLowerCase().trim();
    const base   = _baseUrl(req);
    const entity = isSupplier
      ? await SupplierProfile.findOne({ zqSlug: slug }).lean()
      : await SchoolProfile.findOne({ zqSlug: slug }).lean();
    if (!entity) return res.status(404).send("Profile not found.");

    const canonical = `${base}/${isSupplier?"p":"s"}/${slug}`;
    const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(canonical)}&color=085041&bgcolor=FFFFFF&qzone=2`;
    const name   = entity.schoolName || entity.businessName || "";
    const loc    = [entity.suburb, entity.city].filter(Boolean).join(", ");
    const feeStr = entity.fees?.term1
      ? `$${entity.fees.term1}/term`
      : { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[entity.feeRange] || "";

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>QR Poster – ${esc(name)}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,"Segoe UI",sans-serif;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}.poster{width:400px;border:3px solid #085041;border-radius:20px;padding:28px;text-align:center}.brand{font-size:11px;font-weight:700;color:#0F6E56;letter-spacing:.1em;text-transform:uppercase;margin-bottom:16px}h1{font-size:22px;font-weight:800;color:#0a1a0a;margin-bottom:6px;line-height:1.2}.sub{font-size:13px;color:#5a7a5a;margin-bottom:4px}.adm{display:inline-block;margin:10px 0 0;background:#E1F5EE;color:#0F6E56;font-size:12px;font-weight:700;padding:5px 14px;border-radius:20px}.adm.closed{background:#fee2e2;color:#dc2626}.qrw{margin:18px auto;padding:12px;border:1px solid #E1F5EE;border-radius:12px;display:inline-block}.qrw img{display:block;width:200px;height:200px}.cta{font-size:13px;font-weight:600;color:#0F6E56;margin-bottom:6px}.url{font-size:11px;color:#5a7a5a;font-family:monospace;word-break:break-all;margin-bottom:14px}.how{font-size:12px;color:#888;background:#f0faf5;border-radius:8px;padding:8px 12px;margin-bottom:14px;line-height:1.5}.dets{font-size:12px;color:#5a7a5a;display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}.foot{font-size:10px;color:#aaa}.noprint{margin-top:16px;display:flex;gap:10px;justify-content:center}@media print{.noprint{display:none!important}body{padding:0}}</style>
</head><body>
<div class="poster">
  <div class="brand">ZimQuote · Verified School</div>
  <h1>${esc(name)}</h1>
  <p class="sub">📍 ${esc(loc)}</p>
  ${feeStr?`<p class="sub">${esc(feeStr)}</p>`:""}
  <span class="adm ${entity.admissionsOpen===false?"closed":""}">${entity.admissionsOpen===false?"🔴 Admissions Closed":"🟢 Admissions Open"}</span>
  <div class="qrw"><img src="${esc(qrUrl)}" alt="QR Code"></div>
  <p class="cta">📲 Scan to enquire &amp; see full profile</p>
  <p class="url">${esc(canonical)}</p>
  <div class="how">Open WhatsApp → Camera → Scan this code<br>No app download needed. Works on any phone.</div>
  <div class="dets">
    ${(entity.curriculum||[]).length?`<span>📚 ${entity.curriculum.map(c=>c.toUpperCase()).join(" + ")}</span>`:""}
    ${entity.gender?`<span>${{mixed:"👫 Co-ed",boys:"👦 Boys",girls:"👧 Girls"}[entity.gender]||""}</span>`:""}
    ${entity.boarding?`<span>${{day:"🏠 Day",boarding:"🏫 Boarding",both:"🏠🏫 Day & Boarding"}[entity.boarding]||""}</span>`:""}
  </div>
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
// SCHOOL SMART CARD PAGE — GET /s/:slug  (catch-all — must be LAST)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:slug", async (req, res) => {
  try {
    const isSupplier = req.baseUrl.startsWith("/p");
    if (isSupplier) return _serveSupplierPage(req, res, req.params.slug);

    const slug   = req.params.slug.toLowerCase().trim();
    const source = String(req.query.src || "direct").slice(0, 30);
    const base   = _baseUrl(req);

    const school = await SchoolProfile.findOne({ zqSlug: slug }).lean();
    if (!school) return res.status(404).send(_notFoundPage(slug));

    // Track page view
    SchoolProfile.findByIdAndUpdate(school._id, {
      $inc: { monthlyViews: 1, zqLinkViews: 1 }
    }).catch(() => {});

    // Log anonymous page-view lead stub
    SchoolLead.create({
      schoolId: school._id, schoolPhone: school.phone,
      schoolName: school.schoolName, zqSlug: slug,
      source, actionType: "view", pageViewed: true
    }).catch(() => {});

    const canonical = `${base}/s/${slug}`;
    // OG image is served from our own /og.png route — always works, no missing file
    const ogImage   = `${base}/s/${slug}/og.png`;
    const pageTitle = `${school.schoolName} | ZimQuote`;
    const desc      = _schoolDesc(school);

    const TL = { ecd:"ECD / Preschool", ecd_primary:"ECD + Primary", primary:"Primary School", secondary:"Secondary School", combined:"Combined School" };
    const GL = { mixed:"Co-ed", boys:"Boys Only", girls:"Girls Only" };
    const BL = { day:"Day School", boarding:"Boarding", both:"Day & Boarding" };
    const cur   = (school.curriculum||[]).map(c=>c.toUpperCase()).join(" + ")||"ZIMSEC";
    const facs  = _facilitySnippet(school.facilities||[]);
    const fee   = _feeLabel(school);
    const stars = school.reviewCount > 0
      ? `⭐ ${Number(school.rating).toFixed(1)} (${school.reviewCount} reviews)` : "⭐ New listing";
    const grades = (school.grades?.from && school.grades?.to)
      ? `${school.grades.from} – ${school.grades.to}` : "";

    const sMsg = encodeURIComponent(
      `🏫 ${school.schoolName} – ${school.suburb?school.suburb+", ":""}${school.city}\n`+
      `${fee} · ${TL[school.type]||"School"} · ${cur}\n\n`+
      `See full profile, fees & apply:\n👉 ${canonical}\n\n_Found via ZimQuote_`);

    const ALL_GRADES = ["ECD A","ECD B","Grade 1","Grade 2","Grade 3","Grade 4","Grade 5","Grade 6","Grade 7","Form 1","Form 2","Form 3","Form 4","Form 5","Form 6","Upper 6"];
    const gradeOpts  = ALL_GRADES.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join("");
    const hasDocs    = (school.brochures||[]).length > 0 || !!school.profilePdfUrl;
    const admBadge   = school.admissionsOpen
      ? `<span class="badge-open">🟢 Admissions Open</span>`
      : `<span class="badge-closed">🔴 Admissions Closed</span>`;
    const verBadge   = school.verified ? `<span class="badge-info">✅ Verified</span>` : "";
    const featBadge  = school.tier==="featured" ? `<span class="badge-amber">🔥 Featured</span>` : "";
    const schoolIdStr = String(school._id);

    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(_shell({ pageTitle, desc, ogImage, canonical, body: `
<div class="card">
  <div class="ch">
    <div class="av">${esc(school.schoolName.slice(0,2).toUpperCase())}</div>
    <div class="ht">
      <h1>${esc(school.schoolName)}</h1>
      <p class="loc">📍 ${esc(school.suburb?school.suburb+", ":"")}${esc(school.city)}</p>
      <div class="brow">${admBadge}${verBadge}${featBadge}</div>
    </div>
  </div>

  <div class="ig">
    <div class="ic"><div class="lb">School type</div><div class="iv">${esc(TL[school.type]||school.type||"School")}</div></div>
    <div class="ic"><div class="lb">Curriculum</div><div class="iv">${esc(cur)}</div></div>
    <div class="ic"><div class="lb">Fees per term</div><div class="iv fee">${esc(fee)}</div></div>
    <div class="ic"><div class="lb">Gender · Boarding</div><div class="iv">${esc(GL[school.gender]||"Mixed")} · ${esc(BL[school.boarding]||"Day")}</div></div>
    ${grades?`<div class="ic"><div class="lb">Grades</div><div class="iv">${esc(grades)}</div></div>`:""}
    <div class="ic"><div class="lb">Rating</div><div class="iv">${esc(stars)}</div></div>
  </div>

  ${facs?`<div class="fr"><div class="lb" style="margin-bottom:5px">Facilities</div><div class="ft">${esc(facs)}</div></div>`:""}

  <div class="cs">
    <p class="ch2">So the school knows who you are <span class="opt">(optional)</span></p>
    <input type="text" id="pni" placeholder="Your name e.g. Tendai Moyo" maxlength="60" autocomplete="name">
    <p class="al">What would you like to do?</p>
    <div class="ab">
      <button class="btn pri" onclick="go('fees','${slug}','${source}')">
        <span class="bi">💵</span><span><strong>Request Fees</strong><small>Get the full fee schedule</small></span>
      </button>
      <button class="btn sec" onclick="go('visit','${slug}','${source}')">
        <span class="bi">📅</span><span><strong>Book a School Visit</strong><small>Schedule a tour</small></span>
      </button>
      <button class="btn sec" onclick="showGS()">
        <span class="bi">📝</span><span><strong>Ask About a Place</strong><small>Check space availability</small></span>
      </button>
      ${hasDocs?`<button class="btn sec" onclick="go('pdf','${slug}','${source}')">
        <span class="bi">📄</span><span><strong>Download School Profile</strong><small>PDF sent to your WhatsApp</small></span>
      </button>`:""}
      <button class="btn sec" onclick="go('enquiry','${slug}','${source}')">
        <span class="bi">💬</span><span><strong>Send Enquiry</strong><small>Any other question</small></span>
      </button>
    </div>
    <div id="gs" style="display:none;margin-top:12px">
      <p style="font-size:13px;color:#5a7a5a;margin-bottom:8px">Which grade are you enquiring for?</p>
      <select id="gi" style="width:100%;padding:11px 12px;border:1px solid #c8dac8;border-radius:9px;font-size:14px;color:#1a2e1a;background:#fff;margin-bottom:10px">
        <option value="">Select grade...</option>${gradeOpts}
      </select>
      <button class="btn pri" style="margin-top:0" onclick="goGrade('${slug}','${source}')">
        <span class="bi">📝</span><span><strong>Continue on WhatsApp</strong></span>
      </button>
    </div>
  </div>

  <div class="sr">
    <span class="sl">Share:</span>
    <a href="https://wa.me/?text=${sMsg}" class="sb wa">WhatsApp</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(canonical)}" class="sb fb" target="_blank" rel="noopener">Facebook</a>
    <a href="https://twitter.com/intent/tweet?text=${sMsg}" class="sb tw" target="_blank" rel="noopener">Twitter / X</a>
    <button class="sb cp" id="cpb" onclick="cpLink('${esc(canonical)}')">📋 Copy</button>
  </div>
  <div class="pw">
    <a href="https://zimquote.co.zw" target="_blank" rel="noopener">Powered by <strong>ZimQuote</strong> · Zimbabwe's school finder</a>
  </div>
</div>

<script>
function showGS(){
  var e=document.getElementById("gs");
  e.style.display="block";
  e.scrollIntoView({behavior:"smooth",block:"nearest"});
}
function goGrade(slug,src){
  var g=document.getElementById("gi").value;
  if(!g){alert("Please select a grade.");return;}
  go("place",slug,src,g);
}
async function go(action,slug,src,grade){
  var name=(document.getElementById("pni").value||"").trim();
  var body={parentName:name,action:action,source:src};
  if(grade)body.gradeInterest=grade;
  document.querySelector(".cs").style.opacity="0.6";
  try{
    var r=await fetch("/s/"+slug+"/capture",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body)
    });
    var d=await r.json();
    if(d.redirect)window.location.href=d.redirect;
  }catch(e){
    window.location.href="https://wa.me/${BOT_NUMBER}?text="+encodeURIComponent("ZQ:SCHOOL:${schoolIdStr}:"+action);
  }
}
function cpLink(u){
  navigator.clipboard.writeText(u).then(function(){
    var b=document.getElementById("cpb");
    b.textContent="✅ Copied!";
    setTimeout(function(){b.textContent="📋 Copy";},2000);
  });
}
</script>`
    }));
  } catch (err) {
    console.error("[ZQ SmartCard] GET error:", err.message);
    res.status(500).send(_errorPage());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Supplier Smart Card — GET /p/:slug
// ─────────────────────────────────────────────────────────────────────────────
async function _serveSupplierPage(req, res, slug) {
  try {
    slug = slug.toLowerCase().trim();
    const source   = String(req.query.src || "direct").slice(0, 30);
    const base     = _baseUrl(req);
    const supplier = await SupplierProfile.findOne({ zqSlug: slug }).lean();
    if (!supplier) return res.status(404).send(_notFoundPage(slug));

    SupplierProfile.findByIdAndUpdate(supplier._id, { $inc: { zqLinkViews: 1 } }).catch(() => {});

    const canonical  = `${base}/p/${slug}`;
    const ogImage    = `${base}/p/${slug}/og.png`;
    const name       = supplier.businessName;
    const products   = (supplier.products||[]).slice(0,6).join(" · ") || "Products on request";
    const isService  = supplier.serviceType === "service";
    const delivery   = supplier.delivery?.available ? "🚚 Delivers" : "🏠 Collection only";
    const stars      = (supplier.reviewCount||0)>0
      ? `⭐ ${Number(supplier.rating).toFixed(1)} (${supplier.reviewCount} reviews)` : "⭐ New listing";
    const prices     = isService
      ? (Array.isArray(supplier.rates)&&supplier.rates.length
          ? supplier.rates.slice(0,3).map(r=>`${r.service}: ${r.rate}`).join(" · ")
          : "Rates on request")
      : (Array.isArray(supplier.prices)&&supplier.prices.length
          ? supplier.prices.slice(0,3).map(p=>`${p.product} $${Number(p.amount).toFixed(2)}`).join(" · ")
          : "Prices on request");
    const sMsg = encodeURIComponent(
      `🏪 ${name} – ${supplier.area?supplier.area+", ":""}${supplier.city}\n`+
      `${products}\n\nChat & order:\n👉 ${canonical}\n\n_Found via ZimQuote_`);

    res.setHeader("Cache-Control","public, max-age=60");
    res.send(_shell({
      pageTitle: `${name} | ZimQuote`,
      desc: `${name} in ${supplier.city}. ${products}. Chat now on ZimQuote.`,
      ogImage, canonical,
      body: `
<div class="card">
  <div class="ch">
    <div class="av" style="background:#FAEEDA;color:#854F0B">${esc(name.slice(0,2).toUpperCase())}</div>
    <div class="ht">
      <h1>${esc(name)}</h1>
      <p class="loc">📍 ${esc(supplier.area?supplier.area+", ":"")}${esc(supplier.city)}</p>
      <div class="brow"><span class="badge-open">${isService?"Service Provider":"Supplier"}</span></div>
    </div>
  </div>
  <div class="ig">
    <div class="ic"><div class="lb">Products / services</div><div class="iv">${esc(products)}</div></div>
    <div class="ic"><div class="lb">Pricing</div><div class="iv">${esc(prices)}</div></div>
    <div class="ic"><div class="lb">Delivery</div><div class="iv">${delivery}</div></div>
    <div class="ic"><div class="lb">Rating</div><div class="iv">${esc(stars)}</div></div>
  </div>
  <div class="cs">
    <p class="ch2">So the seller knows who you are <span class="opt">(optional)</span></p>
    <input type="text" id="pni" placeholder="Your name e.g. Tendai Moyo" maxlength="60" autocomplete="name">
    <p class="al">What would you like to do?</p>
    <div class="ab">
      <button class="btn pri" onclick="goS('enquiry','${slug}','${source}')">
        <span class="bi">💬</span><span><strong>Send Enquiry</strong><small>Ask about products or services</small></span>
      </button>
      <button class="btn sec" onclick="goS('fees','${slug}','${source}')">
        <span class="bi">💰</span><span><strong>Request Price List</strong><small>Get full pricing</small></span>
      </button>
    </div>
  </div>
  <div class="sr">
    <span class="sl">Share:</span>
    <a href="https://wa.me/?text=${sMsg}" class="sb wa">WhatsApp</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(canonical)}" class="sb fb" target="_blank" rel="noopener">Facebook</a>
    <a href="https://twitter.com/intent/tweet?text=${sMsg}" class="sb tw" target="_blank" rel="noopener">Twitter / X</a>
    <button class="sb cp" id="cpb" onclick="cpLink('${esc(canonical)}')">📋 Copy</button>
  </div>
  <div class="pw">
    <a href="https://zimquote.co.zw" target="_blank" rel="noopener">Powered by <strong>ZimQuote</strong></a>
  </div>
</div>
<script>
async function goS(action,slug,src){
  var name=(document.getElementById("pni").value||"").trim();
  var body={parentName:name,action:action,source:src};
  document.querySelector(".cs").style.opacity="0.6";
  try{
    var r=await fetch("/p/"+slug+"/capture",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    var d=await r.json();
    if(d.redirect)window.location.href=d.redirect;
  }catch(e){
    window.location.href="https://wa.me/${BOT_NUMBER}?text="+encodeURIComponent("ZQ:SUPPLIER:${String(supplier._id)}:"+action);
  }
}
function cpLink(u){
  navigator.clipboard.writeText(u).then(function(){
    var b=document.getElementById("cpb");
    b.textContent="✅ Copied!";
    setTimeout(function(){b.textContent="📋 Copy";},2000);
  });
}
</script>`
    }));
  } catch (err) {
    console.error("[ZQ SmartCard] supplier page:", err.message);
    res.status(500).send(_errorPage());
  }
}

async function _captureSupplierLead(req, res, slug) {
  try {
    slug = slug.toLowerCase().trim();
    const s = await SupplierProfile.findOne({ zqSlug: slug }).lean();
    if (!s) return res.status(404).json({ error:"Not found" });
    const n = String(req.body.parentName||"").trim().slice(0,80);
    const a = String(req.body.action||"enquiry").trim();
    const payload = `ZQ:SUPPLIER:${s._id}:${a}${n?`:name=${encodeURIComponent(n)}`:""}`;
    res.json({ redirect:`https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent(payload)}` });
  } catch (err) {
    res.status(500).json({ error:"Server error" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared HTML shell — Open Graph + Twitter Card meta, full CSS
// ─────────────────────────────────────────────────────────────────────────────
function _shell({ pageTitle, desc, ogImage, canonical, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<!-- Open Graph — Facebook, WhatsApp link preview, LinkedIn -->
<meta property="og:type"         content="website">
<meta property="og:url"          content="${esc(canonical)}">
<meta property="og:title"        content="${esc(pageTitle)}">
<meta property="og:description"  content="${esc(desc)}">
<meta property="og:image"        content="${esc(ogImage)}">
<meta property="og:image:type"   content="image/svg+xml">
<meta property="og:image:width"  content="1200">
<meta property="og:image:height" content="630">
<meta property="og:site_name"    content="ZimQuote">
<meta property="og:locale"       content="en_ZW">
<!-- Twitter / X card -->
<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:title"       content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image"       content="${esc(ogImage)}">
<meta name="twitter:site"        content="@ZimQuote">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a2e1a;background:#f0faf5}
body{display:flex;flex-direction:column;align-items:center;padding:16px;min-height:100vh}
.card{width:100%;max-width:480px;background:#fff;border-radius:20px;padding:22px;box-shadow:0 2px 24px rgba(0,40,20,.09);margin:8px 0 24px}
.ch{display:flex;align-items:flex-start;gap:14px;margin-bottom:18px}
.av{width:52px;height:52px;border-radius:14px;background:#E1F5EE;color:#0F6E56;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;flex-shrink:0;letter-spacing:-1px}
.ht{flex:1;min-width:0}
h1{font-size:18px;font-weight:700;color:#0a1a0a;line-height:1.2;margin-bottom:4px;word-wrap:break-word}
.loc{font-size:13px;color:#5a7a5a;margin-bottom:6px}
.brow{display:flex;flex-wrap:wrap;gap:5px}
.badge-open{background:#E1F5EE;color:#0F6E56;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px}
.badge-closed{background:#FCEBEB;color:#A32D2D;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px}
.badge-info{background:#E6F1FB;color:#185FA5;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px}
.badge-amber{background:#FAEEDA;color:#854F0B;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px}
.ig{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:14px;border-top:1px solid #eef5ee;padding-top:14px}
.ic{min-width:0}
.lb{font-size:11px;font-weight:600;color:#7a9a7a;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px}
.iv{font-size:13px;color:#1a2e1a;font-weight:500;word-wrap:break-word}
.fee{color:#0F6E56;font-size:15px;font-weight:700}
.fr{margin-bottom:14px;padding:10px 12px;background:#f0faf5;border-radius:10px}
.ft{font-size:13px;color:#2a4a2a;line-height:1.8}
.cs{background:#f8fdf9;border:1px solid #c8dac8;border-radius:14px;padding:16px;margin-bottom:16px;transition:opacity .2s}
.ch2{font-size:13px;color:#5a7a5a;margin-bottom:8px}
.opt{color:#9aaa9a}
.cs input[type=text]{width:100%;padding:11px 13px;border:1px solid #c8dac8;border-radius:9px;font-size:15px;color:#1a2e1a;background:#fff;margin-bottom:14px;outline:none;font-family:inherit}
.cs input:focus{border-color:#1D9E75;box-shadow:0 0 0 2px rgba(29,158,117,.15)}
.al{font-size:12px;font-weight:600;color:#7a9a7a;text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px}
.ab{display:flex;flex-direction:column;gap:9px}
.btn{display:flex;align-items:center;gap:12px;padding:12px 14px;border:none;border-radius:11px;cursor:pointer;text-align:left;font-family:inherit;width:100%;transition:opacity .15s,transform .1s}
.btn:hover{opacity:.88}.btn:active{transform:scale(.98)}
.btn.pri{background:#1D9E75;color:#fff}
.btn.sec{background:#fff;border:1px solid #c8dac8;color:#1a2e1a}
.bi{font-size:20px;flex-shrink:0}
.btn span strong{display:block;font-size:14px;font-weight:600;line-height:1.2}
.btn span small{display:block;font-size:11px;opacity:.75;margin-top:1px}
.btn.pri span small{opacity:.85}
.sr{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:13px 0;border-top:1px solid #eef5ee;border-bottom:1px solid #eef5ee;margin-bottom:13px}
.sl{font-size:12px;color:#7a9a7a;flex-shrink:0}
.sb{font-size:12px;font-weight:600;padding:5px 11px;border-radius:20px;text-decoration:none;cursor:pointer;border:none;font-family:inherit;transition:opacity .15s}
.sb:hover{opacity:.82}
.sb.wa{background:#25D366;color:#fff}
.sb.fb{background:#1877F2;color:#fff}
.sb.tw{background:#000;color:#fff}
.sb.cp{background:#f0f0f0;color:#333}
.pw{text-align:center;font-size:11px;color:#9aaa9a}
.pw a{color:#0F6E56;text-decoration:none}
.pw strong{color:#0F6E56}
@media(max-width:400px){.ig{grid-template-columns:1fr}.bi{font-size:18px}}
</style>
</head>
<body>${body}</body>
</html>`;
}

function _notFoundPage(slug) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found | ZimQuote</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0faf5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.c{background:#fff;border-radius:16px;padding:32px;max-width:400px;width:100%;text-align:center;box-shadow:0 2px 20px rgba(0,40,20,.1)}h2{font-size:20px;margin-bottom:10px;color:#333}p{color:#666;font-size:14px;margin-bottom:20px;line-height:1.6}a{display:inline-block;padding:12px 24px;background:#1D9E75;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px}</style>
</head><body><div class="c"><div style="font-size:48px;margin-bottom:16px">🔍</div><h2>Profile not found</h2><p>The ZimQuote link <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px">${esc(slug)}</code> does not exist or may have changed.</p><a href="https://wa.me/${BOT_NUMBER}?text=Hi+ZimQuote">Search on ZimQuote →</a></div></body></html>`;
}
function _errorPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Error | ZimQuote</title></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Something went wrong</h2><p style="margin:16px 0">Please try again or <a href="https://wa.me/${BOT_NUMBER}?text=Hi+ZimQuote">chat with us on WhatsApp</a>.</p></body></html>`;
}

export default router;