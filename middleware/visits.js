import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";

const BOT_RE = /bot|crawler|spider|curl|wget|facebookexternalhit|googlebot|bingbot|slurp/i;
const STATIC_PREFIXES = ["/static/", "/css/", "/js/", "/images/", "/favicon.ico", "/docs/", "/assets/"];

export function visitTracker(req, res, next) {
  try {
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    const url = req.originalUrl || req.url || "/";

    if (STATIC_PREFIXES.some(p => url.startsWith(p))) return next();
    if (BOT_RE.test(ua)) return next();

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const year = now.getFullYear().toString();
    const path = (url.split("?")[0] || "/");
    const visitorId = req.visitorId || null;

    setImmediate(async () => {
      try {
        const r1 = await Visit.updateOne(
          { day, path },
          {
            $inc: { hits: 1 },
            $setOnInsert: { firstSeenAt: new Date() },
            $set: { lastSeenAt: new Date(), month, year }
          },
          { upsert: true }
        );
        console.log(`[visitTracker] Visit day=${day} path=${path}`, r1);

        if (visitorId) {
          try {
            const r2 = await UniqueVisit.updateOne(
              { day, visitorId, path },
              { $setOnInsert: { firstSeenAt: new Date(), month, year } },
              { upsert: true }
            );
            console.log(`[visitTracker] Unique visitor=${visitorId} path=${path}`, r2);
          } catch (err) {
            if (err.code !== 11000) console.warn("UniqueVisit error:", err);
          }
        }
      } catch (err) {
        console.warn("visitTracker DB error:", err);
      }
    });
  } catch (err) {
    console.warn("visitTracker error:", err);
  } finally {
    next();
  }
}
