// routes/admin_analytics.js
import { Router } from "express";
import Analytics from "../models/analytics.js";
import User from "../models/user.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// Ensure only admins can access
router.use(ensureAuth);
router.use(ensureRole(["admin", "super_admin"]));

/**
 * GET /admin/analytics - Main analytics dashboard
 */
router.get("/analytics", async (req, res) => {
  try {
    const timeRange = req.query.range || "7d"; // 7d, 30d, 90d, all
    
    // Calculate date range
    let startDate = new Date();
    switch (timeRange) {
      case "24h":
        startDate.setHours(startDate.getHours() - 24);
        break;
      case "7d":
        startDate.setDate(startDate.getDate() - 7);
        break;
      case "30d":
        startDate.setDate(startDate.getDate() - 30);
        break;
      case "90d":
        startDate.setDate(startDate.getDate() - 90);
        break;
      default:
        startDate = new Date(0); // all time
    }

    // Get overview stats
    const [
      totalPageViews,
      uniqueVisitors,
      totalUsers,
      avgResponseTime,
      topPages,
      deviceStats,
      dailyStats,
      referrerStats,
      userRoleStats
    ] = await Promise.all([
      // Total page views
      Analytics.countDocuments({
        timestamp: { $gte: startDate },
        method: "GET"
      }),

      // Unique visitors (distinct sessionIds)
      Analytics.distinct("sessionId", {
        timestamp: { $gte: startDate }
      }).then(sessions => sessions.length),

      // Total registered users
      User.countDocuments(),

      // Average response time
      Analytics.aggregate([
        { $match: { timestamp: { $gte: startDate }, responseTime: { $exists: true } } },
        { $group: { _id: null, avg: { $avg: "$responseTime" } } }
      ]).then(r => r[0]?.avg || 0),

      // Top 10 pages
      Analytics.aggregate([
        { $match: { timestamp: { $gte: startDate }, method: "GET" } },
        { $group: { _id: "$path", views: { $sum: 1 }, uniqueUsers: { $addToSet: "$sessionId" } } },
        { $project: { path: "$_id", views: 1, uniqueUsers: { $size: "$uniqueUsers" } } },
        { $sort: { views: -1 } },
        { $limit: 10 }
      ]),

      // Device breakdown
      Analytics.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        { $group: { _id: "$device.type", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),

      // Daily page views (last 30 days for chart)
      Analytics.aggregate([
        { 
          $match: { 
            timestamp: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
            method: "GET"
          } 
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
            views: { $sum: 1 },
            uniqueVisitors: { $addToSet: "$sessionId" }
          }
        },
        {
          $project: {
            date: "$_id",
            views: 1,
            uniqueVisitors: { $size: "$uniqueVisitors" }
          }
        },
        { $sort: { date: 1 } }
      ]),

      // Top referrers
      Analytics.aggregate([
        { 
          $match: { 
            timestamp: { $gte: startDate },
            referrer: { $exists: true, $ne: null, $ne: "" }
          } 
        },
        { $group: { _id: "$referrer", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // User role breakdown
      Analytics.aggregate([
        { $match: { timestamp: { $gte: startDate }, userId: { $exists: true, $ne: null } } },
        { $group: { _id: "$userRole", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    // Calculate bounce rate (single-page sessions)
    const sessionCounts = await Analytics.aggregate([
      { $match: { timestamp: { $gte: startDate } } },
      { $group: { _id: "$sessionId", pageCount: { $sum: 1 } } }
    ]);

    const singlePageSessions = sessionCounts.filter(s => s.pageCount === 1).length;
    const bounceRate = sessionCounts.length > 0 
      ? Math.round((singlePageSessions / sessionCounts.length) * 100)
      : 0;

    // Get active users (last 24 hours)
    const activeUsers = await Analytics.distinct("userId", {
      timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      userId: { $exists: true, $ne: null }
    }).then(users => users.length);

    res.render("admin/analytics/dashboard", {
      user: req.user,
      timeRange,
      stats: {
        totalPageViews,
        uniqueVisitors,
        totalUsers,
        activeUsers,
        avgResponseTime: Math.round(avgResponseTime),
        bounceRate
      },
      topPages,
      deviceStats,
      dailyStats,
      referrerStats,
      userRoleStats
    });

  } catch (error) {
    console.error("[Analytics Dashboard] Error:", error);
    res.status(500).send("Failed to load analytics");
  }
});

/**
 * GET /admin/analytics/realtime - Real-time visitor tracking
 */
router.get("/analytics/realtime", async (req, res) => {
  try {
    const last5Min = new Date(Date.now() - 5 * 60 * 1000);

    const [activeNow, recentPages] = await Promise.all([
      // Active visitors in last 5 minutes
      Analytics.distinct("sessionId", {
        timestamp: { $gte: last5Min }
      }).then(sessions => sessions.length),

      // Recent page views
      Analytics.find({
        timestamp: { $gte: last5Min }
      })
      .sort({ timestamp: -1 })
      .limit(50)
      .populate("userId", "firstName lastName email")
      .lean()
    ]);

    res.render("admin/analytics/realtime", {
      user: req.user,
      activeNow,
      recentPages
    });

  } catch (error) {
    console.error("[Analytics Realtime] Error:", error);
    res.status(500).send("Failed to load realtime analytics");
  }
});

/**
 * GET /admin/analytics/users - User behavior analytics
 */
router.get("/analytics/users", async (req, res) => {
  try {
    const timeRange = req.query.range || "30d";
    let startDate = new Date();
    
    if (timeRange === "30d") startDate.setDate(startDate.getDate() - 30);
    else if (timeRange === "7d") startDate.setDate(startDate.getDate() - 7);
    else startDate = new Date(0);

    // Get user activity stats
    const userActivity = await Analytics.aggregate([
      { 
        $match: { 
          timestamp: { $gte: startDate },
          userId: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: "$userId",
          pageViews: { $sum: 1 },
          sessions: { $addToSet: "$sessionId" },
          lastSeen: { $max: "$timestamp" },
          avgResponseTime: { $avg: "$responseTime" }
        }
      },
      {
        $project: {
          userId: "$_id",
          pageViews: 1,
          sessionCount: { $size: "$sessions" },
          lastSeen: 1,
          avgResponseTime: 1
        }
      },
      { $sort: { pageViews: -1 } },
      { $limit: 100 }
    ]);

    // Populate user details
    const userIds = userActivity.map(u => u.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select("firstName lastName email role")
      .lean();

    const userMap = {};
    users.forEach(u => {
      userMap[String(u._id)] = u;
    });

    const enrichedActivity = userActivity.map(activity => ({
      ...activity,
      user: userMap[String(activity.userId)] || null
    }));

    res.render("admin/analytics/users", {
      user: req.user,
      userActivity: enrichedActivity,
      timeRange
    });

  } catch (error) {
    console.error("[Analytics Users] Error:", error);
    res.status(500).send("Failed to load user analytics");
  }
});

/**
 * GET /admin/analytics/api/summary - API endpoint for dashboard widgets
 */
router.get("/analytics/api/summary", async (req, res) => {
  try {
    const range = req.query.range || "7d";
    let startDate = new Date();
    
    switch (range) {
      case "24h": startDate.setHours(startDate.getHours() - 24); break;
      case "7d": startDate.setDate(startDate.getDate() - 7); break;
      case "30d": startDate.setDate(startDate.getDate() - 30); break;
      default: startDate = new Date(0);
    }

    const [views, visitors, avgTime] = await Promise.all([
      Analytics.countDocuments({ timestamp: { $gte: startDate } }),
      Analytics.distinct("sessionId", { timestamp: { $gte: startDate } }).then(s => s.length),
      Analytics.aggregate([
        { $match: { timestamp: { $gte: startDate }, responseTime: { $exists: true } } },
        { $group: { _id: null, avg: { $avg: "$responseTime" } } }
      ]).then(r => Math.round(r[0]?.avg || 0))
    ]);

    res.json({ views, visitors, avgTime });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

/**
 * GET /admin/analytics/export - Export analytics data as CSV
 */
router.get("/analytics/export", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const query = {};
    if (startDate) query.timestamp = { $gte: new Date(startDate) };
    if (endDate) query.timestamp = { ...query.timestamp, $lte: new Date(endDate) };

    const data = await Analytics.find(query)
      .sort({ timestamp: -1 })
      .limit(10000)
      .lean();

    // Convert to CSV
    const csv = [
      "Timestamp,Path,Method,User ID,User Role,Device,Browser,IP,Response Time",
      ...data.map(row => [
        row.timestamp,
        row.path,
        row.method,
        row.userId || "anonymous",
        row.userRole || "visitor",
        row.device?.type || "",
        row.device?.browser || "",
        row.ip || "",
        row.responseTime || ""
      ].join(","))
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="analytics-${Date.now()}.csv"`);
    res.send(csv);

  } catch (error) {
    console.error("[Analytics Export] Error:", error);
    res.status(500).send("Export failed");
  }
});

export default router;