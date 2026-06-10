// routes/videos.js
// GridFS video upload (admin-only) + public streaming
// ─────────────────────────────────────────────────────
// Install once:
//   npm install multer multer-gridfs-storage gridfs-stream mongoose
//
// Mount in server.js:
//   import videoRoutes from "./routes/videos.js";
//   app.use("/", videoRoutes);
// ─────────────────────────────────────────────────────

import express from "express";
import multer from "multer";
import { GridFSBucket } from "mongodb";
import mongoose from "mongoose";
import { Readable } from "stream";
import path from "path";

const router = express.Router();

// ─── Allowed video MIME types ──────────────────────────────────────────────
const ALLOWED_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime"];
const MAX_SIZE_MB   = 500; // adjust to your needs

// ─── Multer: store in memory, validate on the fly ─────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Invalid file type: ${file.mimetype}. Only MP4/WebM/OGG/MOV allowed.`));
  },
});

// ─── Helper: get GridFSBucket from active mongoose connection ─────────────
function getBucket(bucketName = "videos") {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB not connected yet.");
  return new GridFSBucket(db, { bucketName });
}

// ─── Auth guard (admin only for uploads) ─────────────────────────────────
function adminOnly(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ error: "Login required." });
  }
  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!adminEmails.has((req.user?.email || "").toLowerCase())) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /admin/videos/upload
// Uploads a video file into GridFS
// Body (multipart/form-data):
//   video     - the video file
//   slug      - URL-safe name, e.g. "primitive-accumulation-redistribution"
//   title     - human-readable title
//   episode   - optional episode label, e.g. "01"
// ═══════════════════════════════════════════════════════════════════════════
router.post(
  "/admin/videos/upload",
  adminOnly,
  upload.single("video"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file received." });

    const slug    = (req.body.slug    || "").trim().toLowerCase().replace(/\s+/g, "-");
    const title   = (req.body.title   || req.file.originalname).trim();
    const episode = (req.body.episode || "").trim();

    if (!slug) return res.status(400).json({ error: "slug is required." });

    try {
      const bucket   = getBucket();
      const filename = slug + path.extname(req.file.originalname); // e.g. "you-were-never-weak.mp4"

      // Delete any existing file with the same slug (clean overwrite)
      const existing = await bucket.find({ filename }).toArray();
      for (const f of existing) await bucket.delete(f._id);

      // Open upload stream
      const uploadStream = bucket.openUploadStream(filename, {
        contentType: req.file.mimetype,
        metadata: { slug, title, episode, uploadedAt: new Date(), uploadedBy: req.user._id },
      });

      // Pipe buffer → GridFS
      const readable = Readable.from(req.file.buffer);
      readable.pipe(uploadStream);

      uploadStream.on("error", (err) => {
        console.error("[GridFS upload error]", err);
        res.status(500).json({ error: "Upload failed.", detail: err.message });
      });

      uploadStream.on("finish", () => {
        res.json({
          ok: true,
          filename,
          slug,
          title,
          streamUrl: `/videos/${filename}`,
          fileId:    uploadStream.id,
        });
      });
    } catch (err) {
      console.error("[GridFS upload]", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /admin/videos
// Lists all uploaded videos (admin only)
// ═══════════════════════════════════════════════════════════════════════════
router.get("/admin/videos", adminOnly, async (req, res) => {
  try {
    const bucket = getBucket();
    const files  = await bucket.find({}).sort({ uploadDate: -1 }).toArray();

    const list = files.map(f => ({
      id:          f._id,
      filename:    f.filename,
      title:       f.metadata?.title || f.filename,
      episode:     f.metadata?.episode || "",
      slug:        f.metadata?.slug  || f.filename.replace(/\.[^.]+$/, ""),
      streamUrl:   `/videos/${f.filename}`,
      size_mb:     (f.length / 1024 / 1024).toFixed(2),
      uploadedAt:  f.uploadDate,
      contentType: f.contentType,
    }));

    // Render admin view if requested from a browser, otherwise JSON
    if (req.accepts("html")) {
      return res.render("admin/videos", { videos: list, user: req.user });
    }
    res.json({ ok: true, count: list.length, videos: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /admin/videos/:filename
// Remove a video from GridFS
// ═══════════════════════════════════════════════════════════════════════════
router.delete("/admin/videos/:filename", adminOnly, async (req, res) => {
  try {
    const bucket  = getBucket();
    const files   = await bucket.find({ filename: req.params.filename }).toArray();
    if (!files.length) return res.status(404).json({ error: "File not found." });

    await bucket.delete(files[0]._id);
    res.json({ ok: true, deleted: req.params.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /videos/:filename
// Public video streaming with HTTP Range support (seek, mobile compatible)
// e.g. /videos/primitive-accumulation-redistribution.mp4
// ═══════════════════════════════════════════════════════════════════════════
router.get("/videos/:filename", async (req, res) => {
  const { filename } = req.params;

  try {
    const bucket = getBucket();
    const files  = await bucket.find({ filename }).toArray();

    if (!files.length) {
      return res.status(404).send("Video not found.");
    }

    const file     = files[0];
    const fileSize = file.length;
    const mimeType = file.contentType || "video/mp4";
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      // ── Ranged request (browser seeking / iOS Safari) ────────────────
      const parts   = rangeHeader.replace(/bytes=/, "").split("-");
      const start   = parseInt(parts[0], 10);
      const end     = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024 * 1024 - 1, fileSize - 1);
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges":  "bytes",
        "Content-Length": chunkSize,
        "Content-Type":   mimeType,
        "Cache-Control":  "public, max-age=86400",
      });

      const downloadStream = bucket.openDownloadStreamByName(filename, {
        start,
        end: end + 1,
      });
      downloadStream.pipe(res);

      downloadStream.on("error", (err) => {
        console.error("[GridFS stream error]", err.message);
        if (!res.headersSent) res.status(500).send("Stream error.");
      });
    } else {
      // ── Full file (first load / non-range clients) ───────────────────
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type":   mimeType,
        "Accept-Ranges":  "bytes",
        "Cache-Control":  "public, max-age=86400",
      });

      const downloadStream = bucket.openDownloadStreamByName(filename);
      downloadStream.pipe(res);

      downloadStream.on("error", (err) => {
        console.error("[GridFS stream error]", err.message);
        if (!res.headersSent) res.status(500).send("Stream error.");
      });
    }
  } catch (err) {
    console.error("[GET /videos/:filename]", err);
    res.status(500).send("Server error.");
  }
});

export default router;