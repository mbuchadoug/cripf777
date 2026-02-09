// middleware/analyticsTracker.js
import Analytics from "../models/analytics.js";
import UAParser from "ua-parser-js";

/**
 * Analytics tracking middleware
 * Captures page views, user sessions, device info, and timing
 */
export function trackPageView(req, res, next) {
  // Skip API routes and static assets
  const skipPatterns = [
    /^\/api\//,
    /^\/assets\//,
    /^\/css\//,
    /^\/js\//,
    /^\/images\//,
    /^\/docs\//,
    /\.(?:css|js|jpg|jpeg|png|gif|svg|ico|woff|woff2|ttf|eot)$/i,
    /^\/stripe\/webhook/,
    /^\/health$/
  ];

  const shouldSkip = skipPatterns.some(pattern => pattern.test(req.path));
  if (shouldSkip) return next();

  // Capture request start time
  const startTime = Date.now();

  // Parse user agent
  const parser = new UAParser(req.headers["user-agent"]);
  const uaResult = parser.getResult();

  // Get session ID (from express-session)
  const sessionId = req.sessionID || req.session?.id || "anonymous";

  // Extract UTM parameters
  const utm = {
    source: req.query.utm_source || null,
    medium: req.query.utm_medium || null,
    campaign: req.query.utm_campaign || null,
    term: req.query.utm_term || null,
    content: req.query.utm_content || null
  };

  // Get IP (handle proxies)
  const ip = 
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    null;

  // Intercept res.render and res.send to capture response
  const originalRender = res.render;
  const originalSend = res.send;
  const originalJson = res.json;

  let tracked = false;

  async function saveAnalytics(statusCode) {
    if (tracked) return;
    tracked = true;

    const responseTime = Date.now() - startTime;

    try {
      await Analytics.create({
        sessionId,
        userId: req.user?._id || null,
        userRole: req.user?.role || "visitor",
        path: req.path,
        method: req.method,
        statusCode,
        referrer: req.headers.referer || req.headers.referrer || null,
        userAgent: req.headers["user-agent"] || null,
        device: {
          type: uaResult.device.type || "desktop",
          os: uaResult.os.name || null,
          browser: uaResult.browser.name || null,
          version: uaResult.browser.version || null
        },
        ip,
        responseTime,
        organizationId: req.user?.organization || null,
        utm: Object.values(utm).some(Boolean) ? utm : undefined
      });
    } catch (error) {
      // Log error but don't break request
      console.error("[Analytics] Failed to track:", error.message);
    }
  }

  // Override response methods
  res.render = function (view, options, callback) {
    saveAnalytics(res.statusCode || 200);
    return originalRender.call(this, view, options, callback);
  };

  res.send = function (body) {
    saveAnalytics(res.statusCode || 200);
    return originalSend.call(this, body);
  };

  res.json = function (body) {
    saveAnalytics(res.statusCode || 200);
    return originalJson.call(this, body);
  };

  // Handle early exits (redirects, errors)
  res.on("finish", () => {
    saveAnalytics(res.statusCode);
  });

  next();
}

/**
 * Track specific events (conversions, signups, etc.)
 */
export async function trackEvent(req, eventName, metadata = {}) {
  try {
    const parser = new UAParser(req.headers["user-agent"]);
    const uaResult = parser.getResult();

    await Analytics.create({
      sessionId: req.sessionID || "anonymous",
      userId: req.user?._id || null,
      userRole: req.user?.role || "visitor",
      path: req.path,
      method: "EVENT",
      statusCode: 200,
      referrer: req.headers.referer || null,
      userAgent: req.headers["user-agent"] || null,
      device: {
        type: uaResult.device.type || "desktop",
        os: uaResult.os.name || null,
        browser: uaResult.browser.name || null
      },
      ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
          req.connection.remoteAddress,
      timestamp: new Date(),
      // Store event data in path for filtering
      path: `/event/${eventName}`,
      ...metadata
    });
  } catch (error) {
    console.error("[Analytics] Event tracking failed:", error.message);
  }
}