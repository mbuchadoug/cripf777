// routes/boardroom_api.js
// ─── Public JSON API for The Boardroom OS web front ──────────────────────────
//
// Mount in server.js (near the other /api mounts, AFTER express.json()):
//   import boardroomApiRoutes from "./routes/boardroom_api.js";
//   app.use("/api/boardroom", boardroomApiRoutes);
//
// One read endpoint powers the whole web front; two write endpoints let Kim
// (or an admin) post opportunities/events. Writes are guarded by a shared
// admin key so the public read endpoint stays open and cache-friendly.

import express from "express";
import {
  Boardroom,
  BoardroomOpportunity,
  BoardroomEvent,
  resolveBoardroomMembers,
  serializeOpportunity,
  serializeEvent,
  brOpenUrl,
} from "../services/boardroomBridge.js";

const router = express.Router();

// Allow the static cPanel front-end (different origin) to read this API.
router.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", process.env.BOARDROOM_WEB_ORIGIN || "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Boardroom-Key");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function requireAdmin(req, res, next) {
  const key = req.get("X-Boardroom-Key") || req.query.key;
  if (!process.env.BOARDROOM_ADMIN_KEY || key !== process.env.BOARDROOM_ADMIN_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ── GET /api/boardroom/:slug — everything the web front needs in one call ─────
router.get("/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    const boardroom = await Boardroom.findOne({ slug, active: true }).lean();
    if (!boardroom) return res.status(404).json({ error: "not_found" });

    const [members, oppDocs, evtDocs] = await Promise.all([
      resolveBoardroomMembers(boardroom),
      BoardroomOpportunity.find({ boardroomSlug: slug, active: true })
        .sort({ boosted: -1, createdAt: -1 })
        .lean(),
      BoardroomEvent.find({ boardroomSlug: slug, active: true })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    res.set("Cache-Control", "public, max-age=60");
    res.json({
      boardroom: {
        slug: boardroom.slug,
        name: boardroom.name,
        ownerName: boardroom.ownerName,
        ownerPhone: boardroom.ownerPhone,
        brandColor: boardroom.brandColor || "#CB4A1E",
        tagline: boardroom.tagline || "",
        pillars: boardroom.pillars || [],
        openUrl: brOpenUrl(boardroom.slug),
      },
      members,
      opportunities: oppDocs.map(serializeOpportunity),
      events: evtDocs.map(serializeEvent),
    });
  } catch (err) {
    console.error("[BOARDROOM API GET]", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

// ── POST /api/boardroom/:slug/opportunity — admin post an opportunity ─────────
router.post("/:slug/opportunity", requireAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    const { type, title, org, detail, deadline, boosted } = req.body || {};
    if (!title) return res.status(400).json({ error: "title_required" });
    const doc = await BoardroomOpportunity.create({
      boardroomSlug: slug,
      type: type || "Collaboration",
      title,
      org,
      detail,
      deadline,
      boosted: !!boosted,
    });
    res.json({ ok: true, opportunity: serializeOpportunity(doc.toObject()) });
  } catch (err) {
    console.error("[BOARDROOM API OPP]", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

// ── POST /api/boardroom/:slug/event — admin post an event ─────────────────────
router.post("/:slug/event", requireAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    const { series, title, dateText, venue, priceText, priceUsd, capacity } = req.body || {};
    if (!title) return res.status(400).json({ error: "title_required" });
    const doc = await BoardroomEvent.create({
      boardroomSlug: slug,
      series,
      title,
      dateText,
      venue,
      priceText,
      priceUsd,
      capacity,
    });
    res.json({ ok: true, event: serializeEvent(doc.toObject()) });
  } catch (err) {
    console.error("[BOARDROOM API EVT]", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

export default router;