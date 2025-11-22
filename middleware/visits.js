// middleware/visits.js — safer visit tracker

import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";

const BOT_RE = /bot|crawler|spider|curl|wget|facebookexternalhit|googlebot|bingbot|slurp/i;
const STATIC_PREFIXES = ["/static/", "/css/", "/js/", "/images/", "/favicon.ico", "/docs/", "/assets/"];

export function visitTracker(req, res, next) {
  try {
    const ua = String(req.headers["user-agent"] || "").toLowerCase();
    const url = req.originalUrl || req.url || "/";

    // skip static assets and bots
    if (STATIC_PREFIXES.some(p => url.startsWith(p))) return next();
    if (BOT_RE.test(ua)) return next();

    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const year = String(now.getFullYear());
    const path = (url.split("?")[0] || "/");

    const visitorId = req.visitorId || null;

    // perform DB updates asynchronously so we don't block response
    setImmediate(async () => {
      try {
        // increment or insert day+path doc
        await Visit.updateOne(
          { day, path },
          {
            $inc: { hits: 1 },
            $setOnInsert: { firstSeenAt: now },
            $set: { lastSeenAt: now, month, year }
          },
          { upsert: true }
        );

        // record unique visitor only when we have a visitorId
        if (visitorId) {
          await UniqueVisit.updateOne(
            { day, visitorId, path },
            { $setOnInsert: { firstSeenAt: now, month, year } },
            { upsert: true }
          );
        }
      } catch (e) {
        // do not crash the server on DB errors
        console.warn("[visitTracker] db error:", e && (e.message || e));
      }
    });
  } catch (e) {
    console.warn("visitTracker fatal:", e && (e.message || e));
  } finally {
    return next();
  }
}
