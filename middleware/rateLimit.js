// middleware/rateLimit.js
// Small in-memory rate limiter (no extra dependency). Fine for one PM2 process;
// swap for a Mongo/Redis store if you ever run several processes.
//
//   import { rateLimit } from "../middleware/rateLimit.js";
//   router.post("/login", rateLimit({ windowMs: 15*60e3, max: 20 }), handler)
//
// Keyed by IP + route by default (app has trust proxy = 1, so req.ip is the
// real client IP behind nginx).
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60 * 1000).unref();

export function rateLimit({ windowMs = 15 * 60 * 1000, max = 20, key, message = "Too many attempts. Please wait a few minutes and try again." } = {}) {
  return (req, res, next) => {
    const k = (key ? key(req) : `${req.ip}|${req.baseUrl}${req.path}`);
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(k, b); }
    b.count += 1;
    if (b.count > max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.set("Retry-After", String(retry));
      const wantsJson = req.xhr || (req.get("accept") || "").includes("json") || (req.get("content-type") || "").includes("json");
      return wantsJson ? res.status(429).json({ error: message, retryAfter: retry }) : res.status(429).send(message);
    }
    next();
  };
}
