// routes/supplierSmartLinkAdmin.js
// ─── Smart Link Admin Routes ─────────────────────────────────────────────────
//
// Mount in supplierAdmin.js (or your main router) BEFORE export default router:
//
//   import smartLinkAdminRoutes from "./supplierSmartLinkAdmin.js";
//   router.use("/suppliers/:id/smart-link", smartLinkAdminRoutes);
//
// Or just paste the three route handlers below directly into supplierAdmin.js.
//
// Routes added:
//   GET  /zq-admin/suppliers/:id/smart-link           → view page
//   POST /zq-admin/suppliers/:id/smart-link/assign    → assign / regenerate slug
//   GET  /zq-admin/suppliers/:id/smart-link/qr        → redirect to QR image
//   GET  /zq-admin/suppliers/:id/chatlink             → already exists, now upgraded
//
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SupplierProfile from "../models/supplierProfile.js";
import {
  assignSlugToSupplier,
  buildDeepLink,
  buildAllLinks,
  buildQrImageUrl,
  buildSharableCaption,
  buildProfileCard,
  LINK_SOURCES,
} from "../services/supplierSmartLink.js";

const router = express.Router({ mergeParams: true });

// ── Helper (copy from supplierAdmin.js so routes are self-contained) ──────────
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /zq-admin/suppliers/:id/smart-link
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    // Auto-assign slug if missing (idempotent)
    if (!supplier.zqSlug) {
      try {
        const { assignSlugToSupplier: _assign } = await import("../services/supplierSmartLink.js");
        await _assign(supplier._id);
        // Re-fetch with slug
        const updated = await SupplierProfile.findById(supplier._id).lean();
        if (updated) Object.assign(supplier, updated);
      } catch (_) { /* if slug fails, page still renders without it */ }
    }

    const supplierId = String(supplier._id);
    const slug       = supplier.zqSlug || null;
    const allLinks   = buildAllLinks(supplierId);
    const directLink = buildDeepLink(supplierId, null);
    const qrUrl      = buildQrImageUrl(supplierId, 400);
    const qrUrlLarge = buildQrImageUrl(supplierId, 600);

    // Per-source analytics (from zqSourceViews map in DB)
    const sourceViews       = supplier.zqSourceViews       || {};
    const sourceConversions = supplier.zqSourceConversions || {};
    const totalViews        = supplier.zqLinkViews        || 0;
    const totalConversions  = supplier.zqLinkConversions  || 0;
    const convRate = totalViews > 0
      ? ((totalConversions / totalViews) * 100).toFixed(1)
      : "0.0";

    // Profile card preview (what buyer sees on first open)
    const profileCardPreview = buildProfileCard(supplier);

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">✅ ${esc(req.query.success)}</div>`
      : "";
    const errorMsg = req.query.error
      ? `<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">❌ ${esc(req.query.error)}</div>`
      : "";

    // Source rows table
    const sourceRows = Object.entries(LINK_SOURCES)
      .map(([src, label]) => {
        const views   = sourceViews[src]       || 0;
        const convs   = sourceConversions[src] || 0;
        const srcLink = src === "direct" ? directLink : allLinks[src];
        return `
        <tr>
          <td><strong>${esc(label)}</strong></td>
          <td style="font-family:monospace;font-size:11px;color:#64748b;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${esc(srcLink)}
          </td>
          <td style="text-align:center">${views}</td>
          <td style="text-align:center">${convs}</td>
          <td>
            <button
              onclick="copyText(${JSON.stringify(srcLink)}, this)"
              class="btn btn-sm btn-gray" style="font-size:11px">
              📋 Copy
            </button>
            ${src === "wa" || src === "fb" || src === "sms" ? `
            <button
              onclick="showCaption(${JSON.stringify(src)})"
              class="btn btn-sm btn-blue" style="font-size:11px;margin-left:4px">
              📝 Caption
            </button>` : ""}
          </td>
        </tr>`;
      })
      .join("");

    // Caption data object for JS
    const captionData = {};
    for (const src of ["wa", "fb", "tt", "sms", "ig"]) {
      captionData[src] = buildSharableCaption(supplier, src);
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Smart Link - ${esc(supplier.businessName)} - ZimQuote Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#f1f5f9;--white:#fff;--border:#e2e8f0;--text:#1e293b;--muted:#64748b;
  --blue:#2563eb;--green:#16a34a;--red:#dc2626;--orange:#ea580c;
  --teal:#0d9488;--purple:#7c3aed;--sidebar:#0f172a;--sidebar-w:220px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Syne',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:14px;margin-left:var(--sidebar-w)}
.main{padding:28px;max-width:1100px}
.back-link{display:inline-block;margin-bottom:20px;color:var(--blue);text-decoration:none;font-size:13px;font-family:'IBM Plex Mono',monospace}
.back-link:hover{text-decoration:underline}
h1{font-size:22px;font-weight:800;margin-bottom:4px;letter-spacing:-.5px}
.sub{color:var(--muted);font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
.card{background:var(--white);border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h2{font-size:14px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.qr-wrap{text-align:center;padding:16px 0}
.qr-wrap img{border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);max-width:200px;width:100%}
.qr-caption{font-size:11px;color:var(--muted);margin-top:8px;font-family:'IBM Plex Mono',monospace}
.stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.stat{background:var(--white);border-radius:10px;padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.stat .val{font-size:26px;font-weight:800;line-height:1;font-family:'IBM Plex Mono',monospace}
.stat .lbl{font-size:11px;color:var(--muted);margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
.stat.teal{border-top:3px solid var(--teal)}
.stat.blue{border-top:3px solid var(--blue)}
.stat.green{border-top:3px solid var(--green)}
.stat.purple{border-top:3px solid var(--purple)}
.link-box{background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#0369a1;word-break:break-all;margin-bottom:10px;cursor:pointer;transition:background .15s}
.link-box:hover{background:#e0f2fe}
.btn{display:inline-block;padding:9px 18px;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;transition:all .15s;font-family:'Syne',sans-serif}
.btn:hover{opacity:.88}
.btn-blue{background:var(--blue);color:white}
.btn-green{background:#22c55e;color:white}
.btn-red{background:#ef4444;color:white}
.btn-gray{background:#e2e8f0;color:#475569}
.btn-teal{background:var(--teal);color:white}
.btn-sm{padding:5px 12px;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 12px;background:#f8fafc;border-bottom:2px solid var(--border);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
td{padding:9px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
.profile-preview{background:#0f172a;color:#e2e8f0;border-radius:10px;padding:16px;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.slug-row{display:flex;gap:10px;align-items:center;margin-bottom:16px}
.slug-row input{flex:1;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:'IBM Plex Mono',monospace;font-size:13px;outline:none}
.slug-row input:focus{border-color:var(--blue)}
.toast{position:fixed;bottom:24px;right:24px;background:#1e293b;color:white;padding:10px 20px;border-radius:8px;font-size:13px;font-family:'Syne',sans-serif;font-weight:600;transform:translateY(80px);opacity:0;transition:all .3s;z-index:999}
.toast.show{transform:translateY(0);opacity:1}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:500;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:white;border-radius:14px;padding:24px;max-width:540px;width:calc(100% - 32px);max-height:80vh;overflow-y:auto}
.modal h3{font-size:15px;font-weight:700;margin-bottom:12px}
.modal textarea{width:100%;border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;font-family:'IBM Plex Mono',monospace;line-height:1.6;resize:vertical;min-height:140px;outline:none}
.modal-actions{display:flex;gap:10px;margin-top:14px}
.whatsapp-mockup{background:#e5ddd5;border-radius:12px;padding:16px;max-width:340px;margin:0 auto}
.wa-bubble{background:white;border-radius:12px;padding:10px 14px;font-size:13px;line-height:1.5;font-family:'Syne',sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.1);margin-bottom:8px}
.wa-bubble strong{font-weight:700}
.wa-meta{font-size:10px;color:#94a3b8;text-align:right;margin-top:4px}
@media(max-width:768px){
  body{margin-left:0}.main{padding:16px}
  .grid{grid-template-columns:1fr}.stat-row{grid-template-columns:1fr 1fr}
}
</style>
</head>
<body>
<main class="main">
  <a href="/zq-admin/suppliers/${esc(supplierId)}" class="back-link">← ${esc(supplier.businessName)}</a>
  ${successMsg}${errorMsg}

  <h1>📲 Smart Link</h1>
  <p class="sub">${esc(supplier.businessName)} · ${esc(supplier.location?.area || "")} ${esc(supplier.location?.city || "")} · ${supplier.profileType === "service" ? "Service Provider" : "Product Seller"}</p>

  <!-- ── Analytics summary ─────────────────────────────────────────── -->
  <div class="stat-row">
    <div class="stat teal">
      <div class="val">${totalViews}</div>
      <div class="lbl">Total Link Views</div>
    </div>
    <div class="stat blue">
      <div class="val">${totalConversions}</div>
      <div class="lbl">Conversions</div>
    </div>
    <div class="stat green">
      <div class="val">${convRate}%</div>
      <div class="lbl">Conversion Rate</div>
    </div>
    <div class="stat purple">
      <div class="val">${supplier.completedOrders || 0}</div>
      <div class="lbl">Completed Orders</div>
    </div>
  </div>

  <div class="grid">

    <!-- ── QR Code ──────────────────────────────────────────────────── -->
    <div class="card">
      <h2>QR Code</h2>
      <div class="qr-wrap">
        <img src="${esc(qrUrl)}" alt="QR Code for ${esc(supplier.businessName)}" id="qrImg" />
        <p class="qr-caption">Scan to open seller profile on WhatsApp</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:12px">
        <a href="${esc(qrUrl)}" download="${esc(slug || supplierId)}-qr.png" target="_blank"
           class="btn btn-blue btn-sm">⬇ Download QR (400px)</a>
        <a href="${esc(qrUrlLarge)}" download="${esc(slug || supplierId)}-qr-large.png" target="_blank"
           class="btn btn-teal btn-sm">⬇ Large (600px)</a>
        <a href="/zq-admin/suppliers/${esc(supplierId)}/smart-link/qr" target="_blank"
           class="btn btn-gray btn-sm">🖨 Print View</a>
      </div>
    </div>

    <!-- ── Direct link + slug ────────────────────────────────────────── -->
    <div class="card">
      <h2>WhatsApp Deep Link</h2>
      <p style="font-size:12px;color:var(--muted);margin-bottom:10px">
        This is the main link. Share it anywhere - it opens WhatsApp and loads this seller's profile automatically.
      </p>
      <div class="link-box" onclick="copyText(${JSON.stringify(directLink)}, this)" title="Click to copy">
        ${esc(directLink)}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button onclick="copyText(${JSON.stringify(directLink)}, this)" class="btn btn-blue btn-sm">📋 Copy Link</button>
        <a href="${esc(directLink)}" target="_blank" class="btn btn-green btn-sm">🔗 Test Link</a>
      </div>

      <h2 style="margin-top:16px">Slug / Short Name</h2>
      <p style="font-size:12px;color:var(--muted);margin-bottom:10px">
        A human-readable identifier for this seller. Used internally for reference.
        ${slug ? `Current: <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-family:monospace">${esc(slug)}</code>` : "<em>Not assigned yet</em>"}
      </p>
      <form method="POST" action="/zq-admin/suppliers/${esc(supplierId)}/smart-link/assign">
        <div class="slug-row">
          <input name="slug" value="${esc(slug || "")}" placeholder="e.g. chipos-plumbing-mbare" />
          <button type="submit" class="btn btn-teal btn-sm">💾 Save Slug</button>
        </div>
        <p style="font-size:11px;color:var(--muted)">Leave blank to auto-generate from business name.</p>
      </form>
    </div>
  </div>

  <!-- ── Profile card preview ──────────────────────────────────────────── -->
  <div class="card" style="margin-bottom:20px">
    <h2>What Buyers See First</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:14px">
      This is the profile card displayed to a buyer when they open the smart link in WhatsApp.
      It's generated live from the seller's current data.
    </p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">
      <div>
        <p style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Raw text (chatbot sends this)</p>
        <div class="profile-preview">${esc(profileCardPreview || "No profile data available")}</div>
      </div>
      <div>
        <p style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">WhatsApp preview</p>
        <div class="whatsapp-mockup">
          <div class="wa-bubble">
            <pre style="font-family:inherit;font-size:13px;white-space:pre-wrap;word-break:break-word">${esc(profileCardPreview || "No profile data available")}</pre>
            <div class="wa-meta">ZimQuote Bot · now</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Source-specific links ─────────────────────────────────────────── -->
  <div class="card" style="margin-bottom:20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <h2 style="margin:0">Source-Specific Links & Analytics</h2>
      <span style="font-size:12px;color:var(--muted)">Each link tracks where buyers come from</span>
    </div>
    <div class="table-wrap" style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>Channel</th>
            <th>Link</th>
            <th style="text-align:center">Views</th>
            <th style="text-align:center">Conversions</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${sourceRows}
        </tbody>
      </table>
    </div>
  </div>

  <!-- ── Sharing instructions ───────────────────────────────────────────── -->
  <div class="card">
    <h2>How to Share This Link</h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:4px">
      <div style="padding:14px;background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0">
        <div style="font-size:20px;margin-bottom:6px">📱</div>
        <strong style="font-size:13px">WhatsApp Status</strong>
        <p style="font-size:12px;color:var(--muted);margin-top:4px">Post the QR code or copy the WhatsApp caption. Tap <em>Caption button</em> above for ready text.</p>
      </div>
      <div style="padding:14px;background:#eff6ff;border-radius:10px;border:1px solid #bfdbfe">
        <div style="font-size:20px;margin-bottom:6px">🖨</div>
        <strong style="font-size:13px">Printed Flyers & Posters</strong>
        <p style="font-size:12px;color:var(--muted);margin-top:4px">Download the QR code, add to an A4 flyer with business name. Print at any copy shop.</p>
      </div>
      <div style="padding:14px;background:#fdf4ff;border-radius:10px;border:1px solid #e9d5ff">
        <div style="font-size:20px;margin-bottom:6px">🌐</div>
        <strong style="font-size:13px">Facebook / TikTok Bio</strong>
        <p style="font-size:12px;color:var(--muted);margin-top:4px">Use the Facebook or TikTok source link in your bio. Tap <em>Caption</em> for ready-made post text.</p>
      </div>
    </div>
  </div>

</main>

<!-- Caption modal -->
<div class="modal-overlay" id="captionModal">
  <div class="modal">
    <h3 id="captionTitle">Sharable Caption</h3>
    <textarea id="captionText" rows="7"></textarea>
    <div class="modal-actions">
      <button onclick="copyCaptionText()" class="btn btn-blue">📋 Copy Caption</button>
      <button onclick="closeCaptionModal()" class="btn btn-gray">Close</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const CAPTIONS = ${JSON.stringify(captionData)};
const SOURCE_LABELS = ${JSON.stringify(
  Object.fromEntries(Object.entries(LINK_SOURCES).map(([k, v]) => [k, v]))
)};

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    showToast("✅ Copied to clipboard!");
  }).catch(() => {
    // Fallback
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    showToast("✅ Copied!");
  });
}

function showCaption(src) {
  const caption = CAPTIONS[src] || "";
  const label   = SOURCE_LABELS[src] || src;
  document.getElementById("captionTitle").textContent = label + " Caption";
  document.getElementById("captionText").value = caption;
  document.getElementById("captionModal").classList.add("open");
}

function closeCaptionModal() {
  document.getElementById("captionModal").classList.remove("open");
}

function copyCaptionText() {
  const text = document.getElementById("captionText").value;
  copyText(text, null);
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

// Close modal on overlay click
document.getElementById("captionModal").addEventListener("click", function(e) {
  if (e.target === this) closeCaptionModal();
});
</script>
</body>
</html>`);

  } catch (err) {
    res.send(`<div style="padding:20px;color:red">Error: ${esc(err.message)}</div>`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /zq-admin/suppliers/:id/smart-link/assign
// ─────────────────────────────────────────────────────────────────────────────
router.post("/assign", requireSupplierAdmin, async (req, res) => {
  try {
    const supplierId = req.params.id;
    const rawSlug    = (req.body.slug || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

    const supplier = await SupplierProfile.findById(supplierId);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    if (rawSlug) {
      // Custom slug - check uniqueness
      const existing = await SupplierProfile.findOne({
        zqSlug: rawSlug,
        _id: { $ne: supplier._id }
      });
      if (existing) {
        return res.redirect(`/zq-admin/suppliers/${supplierId}/smart-link?error=${encodeURIComponent("That slug is already taken by " + existing.businessName)}`);
      }
      supplier.zqSlug = rawSlug;
      await supplier.save();
      return res.redirect(`/zq-admin/suppliers/${supplierId}/smart-link?success=${encodeURIComponent("Slug updated: " + rawSlug)}`);
    } else {
      // Auto-generate
      const slug = await assignSlugToSupplier(supplierId, { force: true });
      return res.redirect(`/zq-admin/suppliers/${supplierId}/smart-link?success=${encodeURIComponent("Slug assigned: " + slug)}`);
    }
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/smart-link?error=${encodeURIComponent(err.message)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /zq-admin/suppliers/:id/smart-link/qr  → printable QR page
// ─────────────────────────────────────────────────────────────────────────────
router.get("/qr", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const qrUrl    = buildQrImageUrl(String(supplier._id), 500);
    const directLk = buildDeepLink(String(supplier._id), null);
    const name     = supplier.businessName || "Seller";
    const location = [supplier.location?.area, supplier.location?.city].filter(Boolean).join(", ");

    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>QR - ${name}</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&display=swap" rel="stylesheet">
<style>
@media print{.no-print{display:none}@page{margin:12mm}}
body{font-family:'Syne',sans-serif;background:white;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.poster{text-align:center;max-width:400px;width:100%}
.badge{background:#0f172a;color:#60a5fa;display:inline-block;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:16px}
h1{font-size:26px;font-weight:800;color:#0f172a;margin-bottom:4px;letter-spacing:-.5px}
.loc{color:#64748b;font-size:14px;margin-bottom:20px}
.qr-border{border:3px solid #0f172a;border-radius:16px;padding:12px;display:inline-block;margin-bottom:20px}
.qr-border img{display:block;border-radius:8px}
.cta{font-size:15px;font-weight:700;color:#0f172a;margin-bottom:6px}
.sub{font-size:12px;color:#64748b;margin-bottom:20px}
.url{font-family:monospace;font-size:10px;color:#94a3b8;word-break:break-all;margin-bottom:20px}
.footer{font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px;margin-top:4px}
.footer strong{color:#0f172a}
.no-print{margin-top:16px}
.btn-print{background:#0f172a;color:white;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:'Syne',sans-serif}
</style>
</head><body>
<div class="poster">
  <div class="badge">⚡ ZIMQUOTE</div>
  <h1>${name}</h1>
  <p class="loc">📍 ${location}</p>
  <div class="qr-border">
    <img src="${qrUrl}" width="260" height="260" alt="Scan QR" />
  </div>
  <p class="cta">Scan to see prices &amp; get a quote</p>
  <p class="sub">Opens instantly on WhatsApp · No app download needed</p>
  <p class="url">${directLk}</p>
  <div class="footer">Powered by <strong>ZimQuote</strong> · Zimbabwe's marketplace for products &amp; services</div>
  <div class="no-print"><button class="btn-print" onclick="window.print()">🖨 Print This Page</button></div>
</div>
</body></html>`);
  } catch (err) {
    res.send(`Error: ${err.message}`);
  }
});

export default router;