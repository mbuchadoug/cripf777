// middleware/visits.js
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";

const BOT_RE = /bot|crawler|spider|curl|wget|facebookexternalhit|googlebot|bingbot|slurp/i;

export function visitTracker(req, res, next) {
  try {
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    const url = req.originalUrl || "/";

    if (BOT_RE.test(ua)) return next();

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    const year = now.getFullYear().toString();
    const path = url.split("?")[0];

    const visitorId = req.visitorId;

    setImmediate(async () => {
      try {
        await Visit.updateOne(
          { day, path },
          {
            $inc: { hits: 1 },
            $setOnInsert: { firstSeenAt: now },
            $set: { lastSeenAt: now, month, year }
          },
          { upsert: true }
        );

        if (visitorId) {
          await UniqueVisit.updateOne(
            { day, visitorId, path },
            { $setOnInsert: { firstSeenAt: now, month, year } },
            { upsert: true }
          );
        }
      } catch (e) {
        console.warn("[visitTracker] error:", e.message);
      }
    });

  } catch (e) {
    console.warn("visitTracker fatal error:", e.message);
  }

  next();
}
