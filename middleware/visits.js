// middleware/visits.js (fixed)
import mongoose from "mongoose";
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";

const BOT_RE = /bot|crawler|spider|curl|wget|facebookexternalhit|googlebot|bingbot|slurp/i;
const STATIC_PREFIXES = ["/static/", "/css/", "/js/", "/images/", "/favicon.ico", "/docs/", "/assets/"];

export function visitTracker(req, res, next) {
  try {
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    const url = req.originalUrl || req.url || "/";
    if (STATIC_PREFIXES.some((p) => url.startsWith(p))) return next();
    if (BOT_RE.test(ua)) return next();

    // prepare values
    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const year = now.getFullYear().toString();
    const path = (url.split("?")[0] || "/");

    const visitorId = req.visitorId || null;

    // do DB ops asynchronously so we don't block request handling
    setImmediate(async () => {
      try {
        // only attempt writes if mongoose connected
        if (mongoose.connection.readyState !== 1) {
          // not connected; skip tracking
          console.warn("[visitTracker] skipping DB write — mongoose not connected");
          return;
        }

        // 1) increment total hits (per-day per-path doc)
        // use findOneAndUpdate with distinct operators to avoid conflicting path errors
        await Visit.findOneAndUpdate(
          { day, path },
          {
            $inc: { hits: 1 },
            $setOnInsert: { firstSeenAt: now },
            $set: { lastSeenAt: now, month, year },
          },
          { upsert: true, new: false } // new:false is fine — we just want the write
        ).exec();

        // 2) record unique visit only if we have a visitorId
        if (visitorId) {
          try {
            await UniqueVisit.findOneAndUpdate(
              { day, visitorId, path },
              { $setOnInsert: { firstSeenAt: now, month, year } },
              { upsert: true, new: false }
            ).exec();
          } catch (e) {
            // duplicate key or other expected races can happen — log but don't crash
            if (e && e.code === 11000) {
              // duplicate insert — ignore
            } else {
              console.warn("[visitTracker] uniqueVisit write error:", e && (e.message || e));
            }
          }
        }
      } catch (err) {
        console.warn("[visitTracker] db error:", err && (err.message || err));
      }
    });
  } catch (e) {
    console.warn("visitTracker error:", e && (e.message || e));
  } finally {
    return next();
  }
}
