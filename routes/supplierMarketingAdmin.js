// routes/supplierMarketingAdmin.js
// ─── Seller Smart Link Marketing Admin ───────────────────────────────────────
//
// Gives every seller/supplier the same smart-link marketing kit that schools
// already have: a marketing pitch (description), flyers (images) and
// brochures (PDFs) that are sent to the buyer the moment they open the
// seller's smart link - BEFORE the profile card and the action menu.
//
// Mount in supplierAdmin.js (next to the smart-link mount, additive only):
//
//   import marketingRoutes, { supplierMediaFiles } from "./supplierMarketingAdmin.js";
//   ...
//   router.use("/suppliers/:id/marketing", marketingRoutes);   // admin UI (auth)
//   router.use("/supplier-media", supplierMediaFiles);          // public file serving
//
// Routes added (admin, behind requireSupplierAdmin):
//   GET  /zq-admin/suppliers/:id/marketing                    → manage page
//   POST /zq-admin/suppliers/:id/marketing/pitch              → save pitch text
//   POST /zq-admin/suppliers/:id/marketing/flyer/add          → upload flyer image
//   POST /zq-admin/suppliers/:id/marketing/flyer/:idx/edit    → rename flyer
//   POST /zq-admin/suppliers/:id/marketing/flyer/:idx/delete  → remove flyer
//   POST /zq-admin/suppliers/:id/marketing/brochure/add       → upload brochure
//   POST /zq-admin/suppliers/:id/marketing/brochure/:idx/edit → rename brochure
//   POST /zq-admin/suppliers/:id/marketing/brochure/:idx/delete → remove brochure
//
// Public file routes (NO auth - Meta/WhatsApp must be able to fetch these):
//   GET  /zq-admin/supplier-media/flyer/:filename
//   GET  /zq-admin/supplier-media/brochure/:filename
//
// Storage: GridFS buckets "supplierFlyers" and "supplierBrochures"
// (identical pattern to schoolAdmin.js "schoolFlyers" / "schoolBrochures").
//
// ─────────────────────────────────────────────────────────────────────────────

import express  from "express";
import mongoose from "mongoose";
import multer   from "multer";
import { GridFSBucket } from "mongodb";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SupplierProfile from "../models/supplierProfile.js";

// ── GridFS buckets ────────────────────────────────────────────────────────────
function getFlyerBucket() {
  return new GridFSBucket(mongoose.connection.db, { bucketName: "supplierFlyers" });
}
function getBrochureBucket() {
  return new GridFSBucket(mongoose.connection.db, { bucketName: "supplierBrochures" });
}

// ── Multer - memory storage, piped to GridFS ─────────────────────────────────
const flyerUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5MB max per flyer
  fileFilter: (req, file, cb) => {
    const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only PNG, JPG or WEBP image files are allowed for flyers."));
  }
});

const brochureUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only PDF, JPG, PNG, or WEBP files are allowed."));
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _baseUrl(req) {
  return (process.env.APP_BASE_URL || `https://${req.headers.host}`).replace(/\/$/, "");
}

function _extFromMime(mime) {
  return {
    "image/jpeg": "jpg", "image/png": "png",
    "image/webp": "webp", "application/pdf": "pdf"
  }[mime] || "bin";
}

async function _uploadToBucket(bucket, filename, buffer, mime, metadata) {
  await new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(filename, { contentType: mime, metadata });
    stream.on("finish", resolve);
    stream.on("error",  reject);
    stream.end(buffer);
  });
}

/**
 * Find a GridFS file by filename, with legacy fallback: files uploaded before
 * the nginx fix were stored WITH an extension (e.g. "..._flyer_123.jpg") but
 * may now be requested extension-less. Try exact match first, then each known
 * extension appended.
 */
async function _findBucketFile(bucket, filename) {
  let files = await bucket.find({ filename }).toArray();
  if (files && files.length) return files[0];
  for (const ext of ["jpg", "jpeg", "png", "webp", "pdf"]) {
    files = await bucket.find({ filename: `${filename}.${ext}` }).toArray();
    if (files && files.length) return files[0];
  }
  return null;
}

async function _deleteFromBucket(bucket, url, pathSegment) {
  // url looks like <base>/zq-admin/supplier-media/<pathSegment>/<filename>
  try {
    const parts = String(url || "").split(`/${pathSegment}/`);
    const filename = parts[1];
    if (!filename) return;
    const files = await bucket.find({ filename }).toArray();
    for (const f of files) {
      await bucket.delete(f._id).catch(() => {});
    }
  } catch (_) { /* file already gone - non-critical */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC FILE SERVING ROUTER (exported separately - NO auth middleware)
// Mount at: router.use("/supplier-media", supplierMediaFiles)
// Meta/WhatsApp fetches these URLs to deliver flyers/brochures to buyers.
// ─────────────────────────────────────────────────────────────────────────────
export const supplierMediaFiles = express.Router();

supplierMediaFiles.get("/flyer/:filename", async (req, res) => {
  try {
    const bucket = getFlyerBucket();
    const file   = await _findBucketFile(bucket, req.params.filename);
    if (!file) return res.status(404).send("File not found.");

    res.setHeader("Content-Type",        file.metadata?.mimeType || file.contentType || "image/jpeg");
    res.setHeader("Content-Disposition", `inline; filename="${file.filename}"`);
    res.setHeader("Cache-Control",       "public, max-age=86400");
    if (file.length) res.setHeader("Content-Length", file.length);

    const stream = bucket.openDownloadStreamByName(file.filename);
    stream.on("error", () => res.status(404).send("File not found."));
    stream.pipe(res);
  } catch (err) {
    console.error("[Supplier Flyer Serve]", err.message);
    res.status(500).send("Error serving file.");
  }
});

supplierMediaFiles.get("/brochure/:filename", async (req, res) => {
  try {
    const bucket = getBrochureBucket();
    const file   = await _findBucketFile(bucket, req.params.filename);
    if (!file) return res.status(404).send("File not found.");

    res.setHeader("Content-Type",        file.metadata?.mimeType || file.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${file.filename}"`);
    res.setHeader("Cache-Control",       "public, max-age=86400");
    if (file.length) res.setHeader("Content-Length", file.length);

    const stream = bucket.openDownloadStreamByName(file.filename);
    stream.on("error", () => res.status(404).send("File not found."));
    stream.pipe(res);
  } catch (err) {
    console.error("[Supplier Brochure Serve]", err.message);
    res.status(500).send("Error serving file.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTER (default export)
// Mount at: router.use("/suppliers/:id/marketing", marketingRoutes)
// ─────────────────────────────────────────────────────────────────────────────
const router = express.Router({ mergeParams: true });

// ── Page layout (self-contained, consistent with zq-admin look) ──────────────
function page(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ZimQuote Admin</title>
<style>
  :root{--border:#e2e8f0;--muted:#64748b;--text:#0f172a;--surface:#ffffff;--surface2:#f8fafc}
  *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9;color:var(--text);margin:0;padding:24px}
  .wrap{max-width:900px;margin:0 auto}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;margin-bottom:20px}
  h2{margin:0 0 6px;font-size:20px} h3{margin:0 0 12px;font-size:15px}
  .muted{color:var(--muted);font-size:13px}
  .back-link{display:inline-block;margin-bottom:14px;color:#1d4ed8;text-decoration:none;font-size:13px}
  label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px}
  textarea,input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--surface2)}
  input[type=file]{font-size:13px}
  .btn{display:inline-block;padding:9px 16px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none}
  .btn-green{background:#16a34a;color:#fff}.btn-blue{background:#2563eb;color:#fff}
  .btn-red{background:#dc2626;color:#fff}.btn-gray{background:#e2e8f0;color:#334155}
  .btn-sm{padding:5px 10px;font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 10px;background:var(--surface2);border-bottom:2px solid var(--border);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  td{padding:10px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
  .alert-ok{background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px}
  .alert-err{background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px}
  .note{background:#fef9c3;color:#a16207;border-radius:8px;padding:12px 16px;margin-bottom:18px;font-size:13px;line-height:1.6}
  .thumb{width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border)}
  .inline-form{display:inline}
  .upload-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:14px}
  .upload-row .fg{flex:1;min-width:180px}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

// ── GET / - marketing manage page ─────────────────────────────────────────────
router.get("/", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const okMsg  = req.query.success ? `<div class="alert-ok">✅ ${esc(req.query.success)}</div>` : "";
    const errMsg = req.query.error   ? `<div class="alert-err">⚠️ ${esc(req.query.error)}</div>`   : "";

    const flyers    = supplier.smartLinkFlyers || [];
    const brochures = supplier.brochures || [];
    const base      = `/zq-admin/suppliers/${supplier._id}/marketing`;

    const flyerRows = flyers.length ? flyers.map((f, i) => `
      <tr>
        <td><a href="${esc(f.url)}" target="_blank"><img class="thumb" src="${esc(f.url)}" alt=""/></a></td>
        <td>
          <form method="POST" action="${base}/flyer/${i}/edit" class="inline-form" style="display:flex;gap:6px">
            <input type="text" name="label" value="${esc(f.label || "")}" placeholder="Flyer label" style="max-width:220px"/>
            <button class="btn btn-blue btn-sm">Rename</button>
          </form>
        </td>
        <td class="muted">${f.addedAt ? new Date(f.addedAt).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : ""}</td>
        <td>
          <form method="POST" action="${base}/flyer/${i}/delete" class="inline-form" onsubmit="return confirm('Remove this flyer?')">
            <button class="btn btn-red btn-sm">🗑 Remove</button>
          </form>
        </td>
      </tr>`).join("")
      : `<tr><td colspan="4" class="muted">No flyers uploaded yet.</td></tr>`;

    const brochureRows = brochures.length ? brochures.map((b, i) => `
      <tr>
        <td>${b.isImage ? `<a href="${esc(b.url)}" target="_blank"><img class="thumb" src="${esc(b.url)}" alt=""/></a>` : `📄 <a href="${esc(b.url)}" target="_blank" style="color:#1d4ed8">PDF</a>`}</td>
        <td>
          <form method="POST" action="${base}/brochure/${i}/edit" class="inline-form" style="display:flex;gap:6px">
            <input type="text" name="label" value="${esc(b.label || "")}" placeholder="Brochure label" style="max-width:220px"/>
            <button class="btn btn-blue btn-sm">Rename</button>
          </form>
        </td>
        <td class="muted">${b.addedAt ? new Date(b.addedAt).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : ""}</td>
        <td>
          <form method="POST" action="${base}/brochure/${i}/delete" class="inline-form" onsubmit="return confirm('Remove this brochure?')">
            <button class="btn btn-red btn-sm">🗑 Remove</button>
          </form>
        </td>
      </tr>`).join("")
      : `<tr><td colspan="4" class="muted">No brochures uploaded yet.</td></tr>`;

    res.send(page(`Marketing: ${supplier.businessName}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to ${esc(supplier.businessName)}</a>
      ${okMsg}${errMsg}

      <div class="panel">
        <h2>🎨 Smart Link Marketing - ${esc(supplier.businessName)}</h2>
        <p class="muted" style="margin:0 0 14px">
          When a buyer opens this seller's smart link on WhatsApp they receive, in order:
          (1) the <strong>marketing pitch</strong> below, (2) every <strong>flyer</strong> as an image,
          (3) every <strong>brochure</strong> as a document, then (4) the profile card and the
          usual menu (Get a quote · View catalogue · Place order · Enquiry · Contact · Review).
          Leave everything empty and the buyer sees exactly what they see today - nothing changes.
        </p>
        <div class="note">
          <strong>Tip:</strong> keep the pitch short and sales-focused (max 1000 characters).
          WhatsApp formatting works: *bold*, _italic_, emoji. Same as the school smart link pitch.
        </div>

        <form method="POST" action="${base}/pitch">
          <label>Marketing pitch / description (sent first)</label>
          <textarea name="smartLinkPitch" rows="6" maxlength="1000"
            placeholder="e.g. 🔧 Auto Brakes - Harare's brake &amp; clutch specialists since 2010. We overhaul brakes, clutches and hydraulics for cars, trucks and full fleets. Genuine spares in stock. Free assessment - request a quote below! 🚗">${esc(supplier.smartLinkPitch || "")}</textarea>
          <div style="margin-top:12px;display:flex;gap:10px">
            <button class="btn btn-green">💾 Save Pitch</button>
          </div>
        </form>
      </div>

      <div class="panel">
        <h3>🖼 Flyers (${flyers.length}) - sent as WhatsApp images</h3>
        <table>
          <thead><tr><th>Preview</th><th>Label</th><th>Added</th><th></th></tr></thead>
          <tbody>${flyerRows}</tbody>
        </table>
        <form method="POST" action="${base}/flyer/add" enctype="multipart/form-data" class="upload-row">
          <div class="fg">
            <label>Label (caption shown under the image)</label>
            <input type="text" name="label" placeholder="e.g. July Promo" maxlength="60"/>
          </div>
          <div class="fg">
            <label>Image file (JPG / PNG / WEBP, max 5MB)</label>
            <input type="file" name="flyerFile" accept="image/jpeg,image/png,image/webp" required/>
          </div>
          <button class="btn btn-blue">⬆ Upload Flyer</button>
        </form>
      </div>

      <div class="panel">
        <h3>📄 Brochures (${brochures.length}) - sent as WhatsApp documents</h3>
        <table>
          <thead><tr><th>Type</th><th>Label</th><th>Added</th><th></th></tr></thead>
          <tbody>${brochureRows}</tbody>
        </table>
        <form method="POST" action="${base}/brochure/add" enctype="multipart/form-data" class="upload-row">
          <div class="fg">
            <label>Label (filename the buyer sees)</label>
            <input type="text" name="label" placeholder="e.g. Full Price List 2026" maxlength="60"/>
          </div>
          <div class="fg">
            <label>File (PDF / JPG / PNG / WEBP, max 10MB)</label>
            <input type="file" name="brochureFile" accept=".pdf,application/pdf,image/jpeg,image/png,image/webp" required/>
          </div>
          <button class="btn btn-blue">⬆ Upload Brochure</button>
        </form>
      </div>
    `));
  } catch (err) {
    console.error("[Supplier Marketing Page]", err.message);
    res.status(500).send(`Error: ${esc(err.message)}`);
  }
});

// ── POST /pitch - save the marketing pitch ────────────────────────────────────
router.post("/pitch", requireSupplierAdmin, async (req, res) => {
  const base = `/zq-admin/suppliers/${req.params.id}/marketing`;
  try {
    const pitch = (req.body.smartLinkPitch || "").trim().slice(0, 1000);
    await SupplierProfile.findByIdAndUpdate(req.params.id, { $set: { smartLinkPitch: pitch } });
    res.redirect(`${base}?success=${encodeURIComponent(pitch ? "Marketing pitch saved." : "Marketing pitch cleared.")}`);
  } catch (err) {
    res.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /flyer/add ───────────────────────────────────────────────────────────
router.post("/flyer/add", requireSupplierAdmin, flyerUpload.single("flyerFile"), async (req, res) => {
  const base = `/zq-admin/suppliers/${req.params.id}/marketing`;
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    if (!req.file)  throw new Error("No file uploaded.");

    const mime     = req.file.mimetype;
    const label    = (req.body.label || "").trim().slice(0, 60) || "flyer";
    // NGINX FIX: filename/URL has NO extension. The server's nginx config has a
    // static-asset regex (location ~* \.(jpg|jpeg|png|webp...)$) that intercepts
    // any URL ending in an image extension and serves it from disk - so GridFS
    // image URLs with .jpg never reach Node and 404. Extension-less URLs are
    // proxied normally; Content-Type from GridFS metadata tells the browser and
    // Meta/WhatsApp what the file is. (PDFs never had this issue but we keep the
    // same convention for consistency.)
    const filename = `${supplier._id}_flyer_${Date.now()}`;

    await _uploadToBucket(getFlyerBucket(), filename, req.file.buffer, mime, {
      supplierId:   supplier._id.toString(),
      businessName: supplier.businessName,
      label,
      mimeType: mime
    });

    const fileUrl = `${_baseUrl(req)}/zq-admin/supplier-media/flyer/${filename}`;
    supplier.smartLinkFlyers = supplier.smartLinkFlyers || [];
    supplier.smartLinkFlyers.push({ label, url: fileUrl, mimeType: mime, addedAt: new Date() });
    supplier.markModified("smartLinkFlyers");
    await supplier.save();

    const sizeMB = (req.file.size / 1024 / 1024).toFixed(2);
    res.redirect(`${base}?success=${encodeURIComponent(`Flyer "${label}" uploaded (${sizeMB}MB).`)}`);
  } catch (err) {
    res.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /flyer/:idx/edit - rename ────────────────────────────────────────────
router.post("/flyer/:idx/edit", requireSupplierAdmin, async (req, res) => {
  const base = `/zq-admin/suppliers/${req.params.id}/marketing`;
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    const idx = parseInt(req.params.idx, 10);
    if (supplier && !isNaN(idx) && supplier.smartLinkFlyers?.[idx]) {
      const newLabel = (req.body.label || "").trim().slice(0, 60);
      if (newLabel) supplier.smartLinkFlyers[idx].label = newLabel;
      supplier.markModified("smartLinkFlyers");
      await supplier.save();
    }
    res.redirect(`${base}?success=${encodeURIComponent("Flyer label updated.")}`);
  } catch (err) {
    res.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /flyer/:idx/delete ───────────────────────────────────────────────────
router.post("/flyer/:idx/delete", requireSupplierAdmin, async (req, res) => {
  const base = `/zq-admin/suppliers/${req.params.id}/marketing`;
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    const idx = parseInt(req.params.idx, 10);
    if (supplier && !isNaN(idx) && supplier.smartLinkFlyers?.[idx]) {
      const flyer = supplier.smartLinkFlyers[idx];
      await _deleteFromBucket(getFlyerBucket(), flyer.url, "flyer");
      supplier.smartLinkFlyers.splice(idx, 1);
      supplier.markModified("smartLinkFlyers");
      await supplier.save();
    }
    res.redirect(`${base}?success=${encodeURIComponent("Flyer removed.")}`);
  } catch (err) {
    res.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /brochure/add ────────────────────────────────────────────────────────
router.post("/brochure/add", requireSupplierAdmin, brochureUpload.single("brochureFile"), async (req, res) => {
  const base = `/zq-admin/suppliers/${req.params.id}/marketing`;
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    if (!req.file)  throw new Error("No file uploaded.");

    const mime     = req.file.mimetype;
    const isImage  = mime.startsWith("image/");
    const label    = (req.body.label || "").trim().slice(0, 60) || "brochure";
    // NGINX FIX: no extension in filename/URL - see flyer/add comment above.
    const filename = `${supplier._id}_${Date.now()}`;

    await _uploadToBucket(getBrochureBucket(), filename, req.file.buffer, mime, {
      supplierId:   supplier._id.toString(),
      businessName: supplier.businessName,
      label,
      isImage,
      mimeType: mime
    });

    const fileUrl = `${_baseUrl(req)}/zq-admin/supplier-media/brochure/${filename}`;
    supplier.brochures = supplier.brochures || [];
    supplier.brochures.push({ label, url: fileUrl, isImage, mimeType: mime, addedAt: new Date() });
    supplier.markModified("brochures");
    await supplier.save();

    const sizeMB = (req.file.size / 1024 / 1024).toFixed(2);
    res.redirect(`${base}?success=${encodeURIComponent(`${isImage ? "Image" : "PDF"} "${label}" uploaded (${sizeMB}MB).`)}`);
  } catch (err) {
    res.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /brochure/:idx/edit - rename ─────────────────────────────────────────
router.post("/brochure/:idx/edit", requireSupplierAdmin, async (req, res) => {
  const base = `/zq-admin/suppliers/${req.params.id}/marketing`;
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    const idx = parseInt(req.params.idx, 10);
    if (supplier && !isNaN(idx) && supplier.brochures?.[idx]) {
      const newLabel = (req.body.label || "").trim().slice(0, 60);
      if (newLabel) supplier.brochures[idx].label = newLabel;
      supplier.markModified("brochures");
      await supplier.save();
    }
    res.redirect(`${base}?success=${encodeURIComponent("Brochure label updated.")}`);
  } catch (err) {
    res.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /brochure/:idx/delete ────────────────────────────────────────────────
router.post("/brochure/:idx/delete", requireSupplierAdmin, async (req, res) => {
  const base = `/zq-admin/suppliers/${req.params.id}/marketing`;
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    const idx = parseInt(req.params.idx, 10);
    if (supplier && !isNaN(idx) && supplier.brochures?.[idx]) {
      const brochure = supplier.brochures[idx];
      await _deleteFromBucket(getBrochureBucket(), brochure.url, "brochure");
      supplier.brochures.splice(idx, 1);
      supplier.markModified("brochures");
      await supplier.save();
    }
    res.redirect(`${base}?success=${encodeURIComponent("Brochure removed.")}`);
  } catch (err) {
    res.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
  }
});

export default router;