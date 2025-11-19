// middleware/visits.js
import Visit from "../models/visit.js";

const BOT_RE = /bot|crawler|spider|curl|wget|facebookexternalhit|googlebot|bingbot|slurp/i;
const STATIC_PREFIXES = ["/static/", "/css/", "/js/", "/images/", "/favicon.ico", "/docs/", "/assets/"];

export function visitTracker(req, res, next) {
  try {
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    const url = req.originalUrl || req.url || "/";
    // skip static assets or favicon
    if (STATIC_PREFIXES.some(p => url.startsWith(p))) return next();
    // skip obvious bots
    if (BOT_RE.test(ua)) return next();

    // build daily key
    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const year = now.getFullYear().toString();

    const path = url.split("?")[0];

    // Do the DB operation asynchronously so middleware returns quickly
    setImmediate(async () => {
      try {
        const filter = { day, path };
        const update = {
          $inc: { hits: 1 },
          $setOnInsert: { firstSeenAt: new Date() },
          $set: { lastSeenAt: new Date(), month, year }
        };
        // upsert:true
        await Visit.updateOne(filter, update, { upsert: true });
      } catch (e) {
        // log but do not crash
        console.warn("visitTracker db error:", e?.message || e);
      }
    });
  } catch (e) {
    // ignore and continue
    console.warn("visitTracker error:", e?.message || e);
  } finally {
    return next();
  }
}
